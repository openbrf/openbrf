import { Injectable } from "@nestjs/common";
import type {
  PluginDeliveryReceipt,
  PluginFeeNotification,
  PluginFeeNotificationSummary,
  PluginMemberCharge,
  PluginMemberChargeParty,
} from "@openbrf/plugin-sdk";
import { parseLocalDay } from "@openbrf/shared";

import type { DebitingListRow } from "../charges/debiting-list";
import { MemberChargeService } from "../charges/member-charge.service";
import { PrismaService } from "../database/prisma.service";
import type { DeliveryReceiptRow } from "../delivery-receipts/delivery-receipt";
import { FeeNotificationService } from "../fees/fee-notification.service";
import { residencyHeldOn } from "../registers/held-on";

/**
 * The association's finances, as a plugin may read them.
 *
 * ## The board's own rows, then less
 *
 * Every read starts from what the board's own documents state - the fee notice
 * document and the debiting list, through the services that write those files -
 * so the masking each file applies is applied here by the same code rather than
 * by a second copy of it. A change to what the file withholds reaches a plugin
 * with it. What this adds is only ever more withholding, never less:
 *
 *   The address book's rule that a person with protected personal data never
 *   reaches a plugin. The fee notice file already withholds a protected
 *   household's names; the debiting list withholds a protected person's
 *   apartment and prints their name, because the bookkeeper has to know whom
 *   to invoice. A plugin is not the bookkeeper, so here the name goes as well,
 *   and the board's free text about the charge with it - what was written about
 *   a protected person's charge can say who they are as well as a name can.
 *
 *   A restriction of processing (GDPR art. 18). Handing a row to code the
 *   association installed is a use, and art. 18(2) permits storage rather than
 *   use, which is why the address book leaves a restricted person out. The
 *   files the board hands over do not, because billing them is the association
 *   meeting its own books; a plugin carrying the notice elsewhere is a further
 *   use, so their names are withheld here.
 *
 *   A person the register no longer holds. Their charge stays on the list for
 *   the association's books, and the plugin is told it is withheld rather than
 *   handed an empty name.
 *
 * And a fixed shape, mapped field by field rather than spread: a field added to
 * the board's documents for the board's screen does not reach a plugin until
 * somebody adds it here and to the SDK, which is the point of keeping the two
 * apart that `PluginAddressBookService` gives.
 *
 * ## What is never here
 *
 * A personal identity number - no row carries one. A payment, a balance or a
 * status - core records none. An audit entry per read: a plugin reading the
 * books in its own process is the association's own code, consented to by the
 * board at install, and an entry for every poll would bury the entries that
 * say something. What a plugin writes back - a delivery receipt - is audited.
 */
@Injectable()
export class PluginFinancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feeNotifications: FeeNotificationService,
    private readonly memberCharges: MemberChargeService,
  ) {}

  async notifications(): Promise<PluginFeeNotificationSummary[]> {
    const runs = await this.feeNotifications.list();
    return runs.map((run) => ({
      id: run.notificationId,
      from: run.from,
      to: run.to,
      dueOn: run.dueOn,
      issuedAt: run.issuedAt,
      notices: run.notices,
      total: run.total,
    }));
  }

  async notification(
    id: string,
    now: Date = new Date(),
  ): Promise<PluginFeeNotification | null> {
    if (typeof id !== "string") {
      return null;
    }
    const document = await this.feeNotifications.read(id, now);
    if (document === null) {
      return null;
    }

    const restricted = await this.householdsWithRestriction(
      document.rows.map((row) => row.apartmentId),
      document.to,
    );

    return {
      id: document.notificationId,
      from: document.from,
      to: document.to,
      dueOn: document.dueOn,
      issuedAt: document.issuedAt,
      total: document.total,
      notices: document.rows.map((row) => ({
        id: row.noticeId,
        apartment: {
          id: row.apartmentId,
          label: row.apartment,
          number: row.apartmentNumber,
        },
        holders:
          row.holders.state === "withheld" || restricted.has(row.apartmentId)
            ? { state: "withheld" }
            : { state: "visible", names: [...row.holders.names] },
        amount: row.amount,
        paymentReference: row.paymentReference,
        deliveries: row.deliveries.map(receiptOf),
      })),
    };
  }

  async charges(
    period: { from: string; to: string },
    now: Date = new Date(),
  ): Promise<PluginMemberCharge[]> {
    const { from, to } = (period ?? {}) as { from?: unknown; to?: unknown };
    if (typeof from !== "string" || typeof to !== "string") {
      throw new RangeError(
        'A period is { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }.',
      );
    }
    const list = await this.memberCharges.list(from, to, now);
    return this.withheld(list.rows);
  }

  async charge(id: string): Promise<PluginMemberCharge | null> {
    if (typeof id !== "string") {
      return null;
    }
    const row = await this.memberCharges.find(id);
    if (row === null) {
      return null;
    }
    const [charge] = await this.withheld([row]);
    return charge ?? null;
  }

  /**
   * The apartments where somebody living there on the day has had processing
   * restricted.
   *
   * The whole household, by the rule `holdersOf` applies to protection: naming
   * the others on a flat of two says who the remaining one lives with, and a
   * notice naming only some of its holders would misstate who it is for.
   */
  private async householdsWithRestriction(
    apartmentIds: readonly string[],
    day: string,
  ): Promise<Set<string>> {
    const held = parseLocalDay(day);
    if (apartmentIds.length === 0 || held === null) {
      return new Set();
    }
    const rows = await this.prisma.residency.findMany({
      where: {
        apartmentId: { in: [...apartmentIds] },
        ...residencyHeldOn(held),
        person: { processingRestrictedAt: { not: null } },
      },
      select: { apartmentId: true },
    });
    return new Set(rows.map((row) => row.apartmentId));
  }

  /** The debiting list's rows, with the plugin's own withholding applied. */
  private async withheld(
    rows: readonly DebitingListRow[],
  ): Promise<PluginMemberCharge[]> {
    const personIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.chargedTo.kind === "person" ? [row.chargedTo.personId] : [],
        ),
      ),
    ];
    const persons =
      personIds.length === 0
        ? []
        : await this.prisma.person.findMany({
            where: { id: { in: personIds } },
            select: {
              id: true,
              protectedPersonalData: true,
              processingRestrictedAt: true,
            },
          });
    const nameable = new Set(
      persons
        .filter(
          (person) =>
            !person.protectedPersonalData &&
            person.processingRestrictedAt === null,
        )
        .map((person) => person.id),
    );

    return rows.map((row) => {
      const chargedTo = partyOf(row, nameable);
      const withheld =
        chargedTo.kind === "person" && chargedTo.state === "withheld";
      return {
        id: row.chargeId,
        chargedOn: row.chargedOn,
        chargedTo,
        amount: row.amount,
        vatTreatment: row.vatTreatment,
        vatRatePercent: row.vatRatePercent,
        reason: withheld
          ? { state: "withheld" }
          : { state: "visible", text: row.reason },
        handedToManagerOn: row.handedToManagerOn,
        deliveries: row.deliveries.map(receiptOf),
      };
    });
  }
}

/**
 * Who a charge is on, as a plugin is told it.
 *
 * Named only where the debiting list itself named the person without masking
 * and the register says, now, that nothing stands against naming them to a
 * plugin. Both, because the list's answer is the floor and this is only ever
 * stricter.
 */
function partyOf(
  row: DebitingListRow,
  nameable: ReadonlySet<string>,
): PluginMemberChargeParty {
  const party = row.chargedTo;
  if (party.kind === "apartment") {
    return {
      kind: "apartment",
      apartmentId: party.apartmentId,
      apartment:
        party.apartment.state === "visible" ? party.apartment.label : null,
    };
  }
  if (
    party.protectedPersonalData ||
    party.apartment.state === "masked" ||
    !nameable.has(party.personId)
  ) {
    return { kind: "person", state: "withheld" };
  }
  return {
    kind: "person",
    state: "visible",
    personId: party.personId,
    name: party.name,
    apartment: party.apartment.label,
  };
}

function receiptOf(row: DeliveryReceiptRow): PluginDeliveryReceipt {
  return {
    id: row.id,
    pluginId: row.pluginId,
    channel: row.channel,
    reference: row.reference,
    deliveredAt: row.deliveredAt,
    recordedAt: row.recordedAt,
  };
}
