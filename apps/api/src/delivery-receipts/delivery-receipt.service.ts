import { Injectable } from "@nestjs/common";
import {
  PluginDeliveryRefusedError,
  type PluginDeliveryReceiptInput,
} from "@openbrf/plugin-sdk";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { MEMBER_CHARGE_TARGET_KIND } from "../charges/member-charge.service";
import { lockMemberCharge } from "../charges/member-charge-lock";
import { PrismaService } from "../database/prisma.service";
import { prismaCode } from "../database/sql-state";
import { isUniqueViolation } from "../database/unique-violation";
import {
  DELIVERY_CHANNEL_PATTERN,
  DELIVERY_RECEIPT_FIELDS,
  type DeliveryReceiptRow,
  deliveryReceiptOf,
  MAX_DELIVERY_CHANNEL_LENGTH,
  MAX_DELIVERY_REFERENCE_LENGTH,
} from "./delivery-receipt";

/** The audit log's word for a fee notice, as `memberCharge` is for a charge. */
export const FEE_NOTICE_TARGET_KIND = "feeNotice";

/** A control character anywhere, which the migration's check refuses too. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * Recording that a fee notice or a charge was delivered.
 *
 * ## A receipt, never a paid flag
 *
 * What is written says that a plugin delivered something by a route, at a time,
 * under a reference. It changes nothing on the notice, which is
 * rakenskapsinformation and never edited, and nothing on the charge. There is no
 * method here, or anywhere, that records that money arrived.
 *
 * ## Written by a plugin, through the host
 *
 * The only caller is the plugin host, under finances:recordDelivery, and the
 * plugin's id comes from the host rather than from anything the plugin said:
 * the receipt and its audit entry name the plugin that actually made the call.
 * The entry's channel is PLUGIN and it has no actor, because no person acted.
 *
 * ## Once per delivery
 *
 * The same plugin recording the same target, route and reference again gets
 * the first receipt back, with no second entry in the log. A job retried after
 * a crash between the delivery and the receipt is the ordinary way that
 * happens, and two receipts for one delivery would read as two deliveries.
 */
@Injectable()
export class DeliveryReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async record(
    pluginId: string,
    input: PluginDeliveryReceiptInput,
    now: Date = new Date(),
  ): Promise<DeliveryReceiptRow> {
    const channel = readChannel(input.channel);
    const reference = readReference(input.reference);
    const deliveredAt = readDeliveredAt(input.deliveredAt, now);
    const target = readTarget(input.target);

    const key = {
      pluginId,
      channel,
      reference,
      ...(target.kind === "feeNotice"
        ? { feeNoticeId: target.id }
        : { memberChargeId: target.id }),
    };

    try {
      return await this.prisma.$transaction(async (tx) => {
        let subject: string | null = null;
        if (target.kind === "memberCharge") {
          /*
           * The charge's own lock, so a removal or a correction arriving at the
           * same moment is ordered with this rather than interleaved: a receipt
           * is never written against a charge that is already gone.
           */
          await lockMemberCharge(tx, target.id);
          const charge = await tx.memberCharge.findUnique({
            where: { id: target.id },
            select: { personId: true },
          });
          if (charge === null) {
            throw notFound();
          }
          subject = charge.personId;
        } else {
          const notice = await tx.feeNotice.findUnique({
            where: { id: target.id },
            select: { id: true },
          });
          if (notice === null) {
            throw notFound();
          }
        }

        const existing = await tx.deliveryReceipt.findFirst({
          where: key,
          select: DELIVERY_RECEIPT_FIELDS,
        });
        if (existing !== null) {
          return deliveryReceiptOf(existing);
        }

        const created = await tx.deliveryReceipt.create({
          data: { ...key, deliveredAt },
          select: DELIVERY_RECEIPT_FIELDS,
        });

        await this.audit.record(
          {
            action: "DELIVERY_RECEIPT_RECORDED",
            channel: "PLUGIN",
            actorPersonId: null,
            // From the host, which holds the id from the plugin's manifest.
            pluginId,
            /*
             * The person charged, so a delivery of their charge appears on their
             * own access report beside the charge. Nobody on a notice, for the
             * reason the run's own entry gives: which resident would be the
             * subject is a question the log must not answer by guessing.
             */
            targetPersonId: subject,
            targetKind:
              target.kind === "feeNotice"
                ? FEE_NOTICE_TARGET_KIND
                : MEMBER_CHARGE_TARGET_KIND,
            targetId: target.id,
            /*
             * The plugin, the route and the receipt. Not the reference: it is
             * the receiving system's identifier for a named household's money,
             * it lives on the receipt, and the receipt is erased with the
             * notice while this entry is not.
             */
            context: { pluginId, channel, receiptId: created.id },
          },
          tx,
        );

        return deliveryReceiptOf(created);
      });
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        // Another call recorded the same delivery between the read and the
        // write. Its receipt is this one.
        const recorded = await this.prisma.deliveryReceipt.findFirst({
          where: key,
          select: DELIVERY_RECEIPT_FIELDS,
        });
        if (recorded !== null) {
          return deliveryReceiptOf(recorded);
        }
      }
      // A notice erased by the purge between the read and the write.
      if (prismaCode(cause) === "P2003") {
        throw notFound();
      }
      throw cause;
    }
  }
}

function notFound(): PluginDeliveryRefusedError {
  return new PluginDeliveryRefusedError(
    "target-not-found",
    "There is no such fee notice or charge.",
  );
}

function readTarget(target: unknown): {
  kind: "feeNotice" | "memberCharge";
  id: string;
} {
  if (typeof target === "object" && target !== null) {
    const { kind, id } = target as { kind?: unknown; id?: unknown };
    if (
      (kind === "feeNotice" || kind === "memberCharge") &&
      typeof id === "string" &&
      id.length > 0 &&
      id.length <= 64
    ) {
      return { kind, id };
    }
  }
  throw notFound();
}

function readChannel(channel: unknown): string {
  if (
    typeof channel !== "string" ||
    channel.length > MAX_DELIVERY_CHANNEL_LENGTH ||
    !DELIVERY_CHANNEL_PATTERN.test(channel)
  ) {
    throw new PluginDeliveryRefusedError(
      "channel-invalid",
      `A channel is lowercase letters, digits and single hyphens, at most ${String(MAX_DELIVERY_CHANNEL_LENGTH)} characters.`,
    );
  }
  return channel;
}

/**
 * The reference, refused rather than cleaned.
 *
 * Scanned for a personal identity number for the reason every free text the
 * association stores is: one arrives pasted along with the text around it, and
 * a receiving system that keys its customers by personnummer would hand one
 * back as its reference. The refusal says what was found and never the value.
 */
function readReference(reference: unknown): string {
  if (
    typeof reference !== "string" ||
    reference.length === 0 ||
    reference.length > MAX_DELIVERY_REFERENCE_LENGTH ||
    CONTROL_CHARACTER.test(reference)
  ) {
    throw new PluginDeliveryRefusedError(
      "reference-invalid",
      `A reference is 1 to ${String(MAX_DELIVERY_REFERENCE_LENGTH)} characters with no control characters.`,
    );
  }
  if (scanForPersonalIdentityNumbers(reference).length > 0) {
    throw new PluginDeliveryRefusedError(
      "reference-holds-personal-identity-number",
      "The reference holds a personal identity number and cannot be recorded.",
    );
  }
  return reference;
}

function readDeliveredAt(deliveredAt: unknown, now: Date): Date {
  if (deliveredAt === undefined) {
    return now;
  }
  if (!(deliveredAt instanceof Date) || Number.isNaN(deliveredAt.getTime())) {
    throw new PluginDeliveryRefusedError(
      "delivered-at-invalid",
      "deliveredAt is not a valid Date.",
    );
  }
  if (deliveredAt.getTime() > now.getTime()) {
    throw new PluginDeliveryRefusedError(
      "delivered-in-the-future",
      "A delivery cannot be recorded for a time that has not come.",
    );
  }
  return deliveredAt;
}
