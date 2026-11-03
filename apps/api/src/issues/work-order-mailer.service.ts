import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import {
  type JobSendOptions,
  JobQueueService,
  type TransactionalSql,
} from "../jobs/job-queue.service";
import type { Prisma } from "../generated/prisma/client";
import { failureName } from "../logging/failure";
import type { RenderedMail } from "../mail/mail-template";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import { workOrderMail, type WorkOrderMailProps } from "../mail/templates";
import { lockIssueType } from "./issue-lock";
import { WORK_ORDER_DELIVERY_FAILURES } from "./work-order-delivery";

/**
 * Mailing one work order to its contractor, as a background job.
 *
 * Store, then send. The transaction that accepted the work order wrote it onto
 * the issue with its delivery pending and put this job on the queue, so the
 * record of who received what exists whether or not a mail server ever takes
 * it - which is the record GDPR art. 15(1)(c) and 19 ask for - and a sending
 * that fails says so on the issue rather than losing the work order.
 *
 * The board mailbox reply's rule, unchanged: the row is claimed before it is
 * sent, by a conditional update from PENDING, so a retried job sends only what
 * it never reached and a work order is sent at most once however many times
 * the job runs. A contractor sent the same job twice may do it twice.
 *
 * The claim also reads the issue's type, under the type's lock: a work order
 * still queued when the board ring-fences its type is never mailed, and is
 * recorded as not sent (decision 32, ADR 0055).
 *
 * The language is the association's default: a contractor is on the
 * association's list, not in the register, and has no preference to read.
 *
 * No address is ever in a job payload, and none in a log line: the payload is
 * the work order's identifier, and this worker decrypts the address as it
 * reaches the row.
 */

/** Queue the sending runs on. */
export const WORK_ORDER_QUEUE = "issue-work-order";

/**
 * Where a work order lands once its retries are spent. The handler marks it
 * as given up on, so the issue shows a work order that never went out rather
 * than one still on its way.
 */
export const WORK_ORDER_ABANDONED_QUEUE = "issue-work-order-abandoned";

const WORK_ORDER_JOB_OPTIONS = {
  // For the failures a second attempt can change: a database that went away, a
  // worker that was killed. A mail server refusing the address is recorded on
  // the row instead, and the handler is shown it.
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
  // The mail jobs' common bound (see the board mailbox's reply).
  expireInSeconds: 15 * 60,
  deadLetter: WORK_ORDER_ABANDONED_QUEUE,
} satisfies JobSendOptions;

/** What the claim returns: the fields the mail is made of, all present. */
interface ClaimedWorkOrder {
  recipientName: string;
  recipientEmailCipher: string;
  body: string;
}

/** Payload of the sending job. One id, and deliberately nothing else. */
interface WorkOrderJob {
  workOrderId: string;
  [key: string]: unknown;
}

@Injectable()
export class WorkOrderMailerService implements OnModuleInit {
  private readonly logger = new Logger(WorkOrderMailerService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the job themselves.
      return;
    }
    await this.startWorker();
  }

  /** Registers the workers. Public so an integration test can drive the job. */
  async startWorker(): Promise<void> {
    await this.jobs.work<WorkOrderJob>(WORK_ORDER_QUEUE, async (data) => {
      await this.send(data.workOrderId);
    });
    await this.jobs.work<WorkOrderJob>(
      WORK_ORDER_ABANDONED_QUEUE,
      async (data) => {
        await this.recordAbandoned(data.workOrderId);
      },
    );
  }

  /**
   * Creates the queues the sending uses. Awaited before the transaction that
   * accepts the work order opens, because creating a queue is the queue
   * backend's own work on its own connection.
   */
  async ensureQueues(): Promise<void> {
    await this.jobs.ensureQueue(WORK_ORDER_QUEUE);
    await this.jobs.ensureQueue(WORK_ORDER_ABANDONED_QUEUE);
  }

  /**
   * Puts the sending on the queue inside the transaction that wrote the work
   * order, so the two commit together or not at all.
   */
  async enqueueInTransaction(
    tx: TransactionalSql,
    workOrderId: string,
  ): Promise<void> {
    await this.jobs.sendInTransaction<WorkOrderJob>(
      tx,
      WORK_ORDER_QUEUE,
      { workOrderId },
      WORK_ORDER_JOB_OPTIONS,
    );
  }

  /**
   * The work order as its contractor will receive it, for the handler's
   * preview. Rendered by the same template and props the sending uses, so the
   * preview cannot drift from the mail.
   */
  async render(props: WorkOrderMailProps): Promise<RenderedMail> {
    return this.mail.renderMail(this.workOrderMail(props));
  }

  /** Sends one work order, and says what it did. */
  async send(workOrderId: string): Promise<"sent" | "failed" | "skipped"> {
    const order = await this.prisma.$transaction((tx) =>
      this.claim(tx, workOrderId),
    );
    if (order === "ring-fenced") {
      this.logger.warn(
        `Work order ${workOrderId} was not sent: its issue type is ring-fenced.`,
      );
      return "failed";
    }
    if (order === null) {
      return this.settleUnclaimed(workOrderId);
    }

    let sent: { suppressed?: true };
    try {
      const to = await this.encryption.decrypt(
        "workOrder.recipientEmail",
        order.recipientEmailCipher,
        workOrderId,
      );
      sent = await this.mail.send({
        to,
        ...this.workOrderMail({
          recipientName: order.recipientName,
          body: order.body,
        }),
      });
    } catch (error) {
      await this.fail(
        workOrderId,
        error instanceof MailNotConfiguredError
          ? WORK_ORDER_DELIVERY_FAILURES.mailNotConfigured
          : WORK_ORDER_DELIVERY_FAILURES.refused,
      );
      // By the work order and the class of the failure, never the address and
      // never the mail server's own words, which quote it back.
      this.logger.error(
        `Work order ${workOrderId} failed: ${failureName(error)}`,
      );
      return "failed";
    }

    if (sent.suppressed === true) {
      // No mail server is configured, outside production, where the mail
      // service drops the message rather than refusing it. Nothing left the
      // instance, and the record must not say a contractor was mailed. Not a
      // null message identifier, which a transport that accepted the message
      // and reported none answers too.
      await this.fail(
        workOrderId,
        WORK_ORDER_DELIVERY_FAILURES.mailNotConfigured,
      );
      this.logger.warn(
        `Work order ${workOrderId} was not sent: no mail server is configured.`,
      );
      return "failed";
    }

    // Outside the block above on purpose: a write that fails here cannot
    // unsend the mail, and recording a failure would be the one certainly
    // untrue thing. The row stays claimed and pending, the job fails, and the
    // dead letter records the delivery as unconfirmed.
    await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: { deliveryStatus: "SENT" },
    });
    return "sent";
  }

  /**
   * Marks a work order as given up on, once its retries are spent. Only one
   * still pending is touched; one an attempt had claimed may have gone out, and
   * is recorded as unconfirmed rather than as not sent.
   */
  async recordAbandoned(workOrderId: string): Promise<void> {
    const neverClaimed = await this.prisma.workOrder.updateMany({
      where: { id: workOrderId, deliveryStatus: "PENDING", claimedAt: null },
      data: {
        deliveryStatus: "FAILED",
        deliveryFailure: WORK_ORDER_DELIVERY_FAILURES.interrupted,
      },
    });
    const claimed = await this.prisma.workOrder.updateMany({
      where: {
        id: workOrderId,
        deliveryStatus: "PENDING",
        claimedAt: { not: null },
      },
      data: {
        deliveryStatus: "FAILED",
        deliveryFailure: WORK_ORDER_DELIVERY_FAILURES.unconfirmed,
        claimedAt: null,
      },
    });

    this.logger.error(
      `Work order ${workOrderId} was given up on (${String(neverClaimed.count)} unclaimed, ${String(claimed.count)} claimed row).`,
    );
  }

  /**
   * Claims a work order for this attempt, and returns what it mails; or
   * records it as not sent because its issue's type is ring-fenced; or, for
   * anything else the claim did not take, null.
   *
   * Under the issue type's lock, which `IssueTypeService.setRingFence` takes
   * too, so the board ring-fencing the type and this claim are decided one
   * after the other: a ring-fence that commits first is read by the claim,
   * which then refuses the work order, and one that comes second waits for
   * the claim and cannot recall the mail that follows it. The type is read
   * before the lock, unlocked: nothing moves an issue to another type.
   *
   * The claim and the read of what it sends are one statement, so what is
   * mailed is what the row held at the moment it was claimed. Reading first
   * and claiming after would let an erasure commit in between: the claim
   * would still succeed, and the worker would mail a contractor, or a text,
   * the database no longer holds. Under READ COMMITTED a concurrent erasure
   * that holds the row makes this statement wait and re-test its conditions
   * against the erased row, which then no longer qualifies.
   *
   * It writes the time and not the outcome: SENT would say a mail server
   * accepted it, which nothing knows yet (see the board mailbox's reply for
   * the whole argument). The claim commits before the mail is sent, and no
   * lock is held while a mail server answers.
   */
  private async claim(
    tx: Prisma.TransactionClient,
    workOrderId: string,
  ): Promise<ClaimedWorkOrder | "ring-fenced" | null> {
    const located = await tx.workOrder.findUnique({
      where: { id: workOrderId },
      select: { issue: { select: { typeId: true } } },
    });
    if (located === null) {
      return null;
    }
    await lockIssueType(tx, located.issue.typeId);

    const [order] = await tx.$queryRaw<ClaimedWorkOrder[]>`
      UPDATE "work_order"
      SET "claimedAt" = now() AT TIME ZONE 'UTC'
      WHERE "id" = ${workOrderId}
        AND "deliveryStatus" = 'PENDING'
        AND "claimedAt" IS NULL
        AND "recipientName" IS NOT NULL
        AND "recipientEmailCipher" IS NOT NULL
        AND "body" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "issue"
          JOIN "issue_type" ON "issue_type"."id" = "issue"."typeId"
          WHERE "issue"."id" = "work_order"."issueId"
            AND "issue_type"."ringFenced"
        )
      RETURNING "recipientName", "recipientEmailCipher", "body"
    `;
    if (order !== undefined) {
      return order;
    }

    // Not taken. If the ring-fence is why, the work order is recorded as not
    // sent here, under the same lock, so the ring-fence this reads is the one
    // the claim refused on; anything else is settled after the transaction.
    const { count } = await tx.workOrder.updateMany({
      where: {
        id: workOrderId,
        deliveryStatus: "PENDING",
        claimedAt: null,
        issue: { type: { ringFenced: true } },
      },
      data: {
        deliveryStatus: "FAILED",
        deliveryFailure: WORK_ORDER_DELIVERY_FAILURES.ringFenced,
      },
    });
    return count > 0 ? "ring-fenced" : null;
  }

  /** The template a work order is sent with, and what fills it in. */
  private workOrderMail(props: WorkOrderMailProps): {
    locale: null;
    template: typeof workOrderMail;
    props: WorkOrderMailProps;
  } {
    // The association's default: see the note at the top of this file.
    return { locale: null, template: workOrderMail, props };
  }

  /**
   * Settles a work order the claim did not take, and says what it did.
   *
   * Gone: its issue was removed between the handler pressing send and this
   * run, and took the work order with it. Still pending and unclaimed, with
   * the contractor or the text erased: erased before the claim, so nothing is
   * sent, and the failure says which was erased. Claimed and unsettled: the
   * attempt that claimed it stopped before recording an outcome, or is still
   * running, and the job fails, because a completed job is never looked at
   * again and failing it is what brings the work order to the dead letter,
   * which settles it. Anything else was settled already.
   */
  private async settleUnclaimed(
    workOrderId: string,
  ): Promise<"failed" | "skipped"> {
    const row = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: {
        deliveryStatus: true,
        claimedAt: true,
        recipientName: true,
        recipientEmailCipher: true,
      },
    });
    if (row === null) {
      this.logger.warn(
        `Work order ${workOrderId} was gone before it was sent.`,
      );
      return "skipped";
    }
    if (row.deliveryStatus !== "PENDING") {
      return "skipped";
    }
    if (row.claimedAt !== null) {
      throw new Error(
        `Work order ${workOrderId} is claimed by an attempt that has not recorded its outcome.`,
      );
    }

    // Unclaimed and pending, yet the claim found a field missing: erased
    // before the claim, however long before. Recorded only while it is still
    // unclaimed and pending, so a claim another attempt made since is left.
    const failure =
      row.recipientName === null || row.recipientEmailCipher === null
        ? WORK_ORDER_DELIVERY_FAILURES.recipientRemoved
        : WORK_ORDER_DELIVERY_FAILURES.textErased;
    const { count } = await this.prisma.workOrder.updateMany({
      where: { id: workOrderId, deliveryStatus: "PENDING", claimedAt: null },
      data: { deliveryStatus: "FAILED", deliveryFailure: failure },
    });
    if (count === 0) {
      return "skipped";
    }
    this.logger.warn(
      `Work order ${workOrderId} had nothing left to send: ${failure}.`,
    );
    return "failed";
  }

  private async fail(workOrderId: string, failure: string): Promise<void> {
    await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: {
        deliveryStatus: "FAILED",
        deliveryFailure: failure,
        claimedAt: null,
      },
    });
  }
}
