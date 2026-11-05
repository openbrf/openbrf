import { randomUUID } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  normalizeFreeText,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { readAuthors } from "../feed/feed-author";
import { Prisma } from "../generated/prisma/client";
import { failureName } from "../logging/failure";
import { MailService } from "../mail/mail.service";
import { ContractorService } from "./contractor.service";
import { issueReaderScope, issuesHandledWhere } from "./issue-handlers";
import { lockIssue, lockIssueType, lockWorkOrderSender } from "./issue-lock";
import type { IssueHandlerView } from "./issue.service";
import { IssueError } from "./issue.error";
import {
  WORK_ORDER_NEVER_LEFT,
  type WorkOrderDeliveryFailure,
} from "./work-order-delivery";
import {
  type ChoosablePhotoView,
  WorkOrderLinkService,
  type WorkOrderLinkRecordView,
} from "./work-order-link.service";
import { WorkOrderMailerService } from "./work-order-mailer.service";
import {
  previewKey,
  previewMatches,
  type PreviewedWorkOrder,
  signPreview,
  WORK_ORDER_PREVIEW_TTL_MS,
} from "./work-order-preview-token";

/**
 * How long a work order to a contractor on an issue is taken for a second
 * press of the same button, and refused: as long as a preview stays valid, so
 * one preview cannot be sent twice once it may have left. A sending whose answer was lost, pressed
 * again later than a shorter window, would otherwise find its first order gone
 * from the check and mail the contractor a second time. The preview is the
 * sending's key; what a repeat within it meets is this refusal, and the screen
 * reads the list of work orders again to show the first.
 *
 * The refusal is for the same text, and also for any text while an earlier work
 * order to that contractor on that issue has had its text redacted inside the
 * window: its words are gone, so a repeat cannot be told from a new order, and
 * a handler who redacts a mistaken order and sends a corrected one within the
 * window meets it and sends the correction when the window has passed. An
 * earlier order known not to have left this instance (`WORK_ORDER_NEVER_LEFT`)
 * is not counted: its handler is told to write it again.
 */
export const WORK_ORDER_DUPLICATE_WINDOW_MS = WORK_ORDER_PREVIEW_TTL_MS;

/**
 * How many work orders one handler may send in an hour, from every issue
 * together. Far above what a board writes in a day; there so that a script on
 * a handler's session - or a hijacked one - cannot mail the association's
 * contractors from its address as often as it likes.
 */
export const WORK_ORDER_SEND_BUDGET = { count: 20, windowMs: 60 * 60 * 1000 };

/** What a handler writes: whom to, and the job in their own words. */
export interface WorkOrderInput {
  contractorId: string;
  body: string;
}

/** A sending: the work order, and the token of the preview it was read in. */
export interface WorkOrderSending extends WorkOrderInput {
  previewToken: string;
}

/**
 * A work order as its contractor will receive it, before it is sent: the
 * recipient, and the mail's subject and text as the template renders them.
 */
export interface WorkOrderPreview {
  recipient: { name: string; email: string };
  subject: string;
  /** The mail's plain-text part, which is the whole of what it says. */
  text: string;
  /**
   * Whether this instance can send mail. A work order sent where it cannot
   * is recorded and fails to go out; the handler is told before they send.
   */
  mailConfigured: boolean;
  /**
   * What the sending must carry: a signature over this recipient and this
   * text, so what is sent is what was previewed (`work-order-preview-token.ts`).
   */
  previewToken: string;
}

/**
 * One work order on an issue, as its handlers read the record: whom it went
 * to, when, what it said, who sent it, and whether the mail went out.
 */
export interface WorkOrderView {
  id: string;
  /** The contractor on the list, or null once they were removed from it. */
  contractorId: string | null;
  /** Null once the contractor was removed from the list and with it erased. */
  recipientName: string | null;
  recipientEmail: string | null;
  /**
   * Null once the retention window after the issue was closed ran out, or
   * once a handler redacted it.
   */
  body: string | null;
  /** When a handler redacted the text, or null (ADR 0057). */
  redactedAt: string | null;
  sentBy: IssueHandlerView | null;
  sentAt: string;
  deliveryStatus: "PENDING" | "SENT" | "FAILED";
  deliveryFailure: WorkOrderDeliveryFailure | null;
  /**
   * The contractor's link to it (ADR 0055): where the link stands, the
   * contractor's answer, notes and photographs, and the photographs chosen
   * for it. Listed whether or not the switch is on, so what came through a
   * link stays on the record after the switch is turned off.
   */
  contractorLink: WorkOrderLinkRecordView;
}

export interface IssueWorkOrdersView {
  /**
   * Whether nothing about the issue may reach a contractor (ADR 0055). The
   * screen offers no work order then; the record of any sent before is still
   * listed.
   */
  ringFenced: boolean;
  /**
   * Whether the issue is done. No work order is offered then either: its text
   * would stand for ten years on a case whose reporter's address the closing
   * job may already have cleared, so no later hold could reach it. The
   * handler reopens the issue to write one.
   */
  closed: boolean;
  /**
   * Whether contractors' links are switched on (decision 25). Off, the screen
   * offers no link and no choice of photographs, only the withdrawal of a link
   * issued while it was on, which the record still lists as `live`.
   */
  linksEnabled: boolean;
  /**
   * The issue's photographs a handler may choose for a link, while the switch
   * is on; none while it is off.
   */
  choosablePhotos: ChoosablePhotoView[];
  /**
   * Whether somebody the issue concerns, its reporter or a person who lives
   * in its apartment today, has protected personal data. No link is given
   * then, and every link given before is ended (ADR 0055).
   */
  protectedHousehold: boolean;
  workOrders: WorkOrderView[];
}

/**
 * Work orders (arbetsorder): what a handler sends a contractor about one
 * issue, previewed before it leaves and recorded with whom it went to, when and
 * what it said (decision 23 of the issue module's plan, GDPR art. 15(1)(c) and
 * 19).
 *
 * Reached with issues:handle, for an issue the reader handles: the rule every
 * read and write in the issues module answers inside its service
 * (`issueReaderScope`), so a property manager reaches the work orders of the
 * issues they handle and of no other.
 *
 * Mailed, because the contractor's own link is switched off until the legal
 * review clears it (decision 25); this path is what a release ships with
 * whatever that review says, and asks nothing of the switch.
 *
 * Three refusals are made here and in the preview alike, so a handler is never
 * shown a mail that would then not be sent:
 *
 * - **A ring-fenced issue** (ADR 0055): nothing about it reaches a contractor,
 *   whoever handles it.
 * - **A personal identity number** in the text, which has no business in a
 *   mail to a firm. The text a handler writes is otherwise theirs: the board
 *   decides what a contractor needs to know, and the preview shows them what
 *   they decided.
 * - **A contractor who is off the list**, switched off, or has no address.
 */
@Injectable()
export class WorkOrderService {
  private readonly logger = new Logger(WorkOrderService.name);

  private readonly previewKey: Buffer;

  constructor(
    @Inject(ENV) env: Env,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    private readonly mailer: WorkOrderMailerService,
    private readonly contractors: ContractorService,
    private readonly links: WorkOrderLinkService,
  ) {
    this.previewKey = previewKey(env.BETTER_AUTH_SECRET);
  }

  /**
   * The work orders on an issue the reader handles, oldest first. The handler
   * check and the read share one snapshot, as the conversation's reads do
   * (`readHandled`), so a board-only change or a handover committed between
   * them cannot hand back work orders the check did not cover.
   */
  async list(
    readerPersonId: string,
    issueId: string,
  ): Promise<IssueWorkOrdersView> {
    const { issue, rows, linkViews, choosable } =
      await this.prisma.$transaction(
        async (tx) => {
          const handled = await this.requireHandled(
            tx,
            issueId,
            readerPersonId,
          );
          const found = await tx.workOrder.findMany({
            where: { issueId: handled.id },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: WORK_ORDER_SELECT,
          });
          return {
            issue: handled,
            rows: found,
            linkViews: await this.links.recordViews(
              tx,
              handled.id,
              found.map((row) => row.id),
            ),
            choosable:
              this.links.enabled && !handled.type.ringFenced
                ? await this.links.choosableOf(tx, handled.id)
                : [],
          };
        },
        { isolationLevel: "RepeatableRead" },
      );
    return {
      ringFenced: issue.type.ringFenced,
      closed: issue.closed,
      linksEnabled: this.links.enabled,
      choosablePhotos: choosable,
      protectedHousehold: linkViews.protectedHousehold,
      workOrders: await this.views(rows, linkViews.views),
    };
  }

  /**
   * The mail a work order would be, without sending or storing anything. Every
   * refusal the sending makes is made here as well.
   */
  async preview(
    readerPersonId: string,
    issueId: string,
    input: WorkOrderInput,
  ): Promise<WorkOrderPreview> {
    const prepared = await this.prepare(
      this.prisma,
      issueId,
      readerPersonId,
      input,
    );
    const [rendered, mailConfigured] = await Promise.all([
      this.mailer.render({
        recipientName: prepared.recipient.name,
        body: prepared.body,
      }),
      this.mail.isConfigured(),
    ]);
    return {
      recipient: prepared.recipient,
      subject: rendered.subject,
      text: rendered.text,
      mailConfigured,
      previewToken: signPreview(
        this.previewKey,
        previewed(issueId, readerPersonId, prepared),
        new Date(),
      ),
    };
  }

  /**
   * Records a work order on the issue and puts its mail on the queue, in one
   * transaction: the record exists before anything leaves, and a mail that
   * fails says so on it (store, then send).
   *
   * Under the issue type's lock and then the issue's, the order every write in
   * the module takes them in, so a change to who handles the type - or to
   * whether it is ring-fenced - is not decided around.
   *
   * What is sent is what was previewed. The contractor's row is locked before
   * it is read, so a change the board makes to the list waits for this
   * sending to commit, and the recipient and text read under that lock must be
   * the ones the preview signed; anything else - an address changed since, a
   * different text, a preview over half an hour old - is refused, and the
   * handler previews again.
   *
   * The same text to the same contractor on the same issue within half an hour
   * (the life of a preview) is refused as the second press it almost always is, and a handler has a
   * budget of sendings an hour across every issue, held under a lock of its
   * own.
   *
   * The audit entry names the handler, the issue, the work order and the
   * contractor, and how long the text was. Never a word of it, and never the
   * contractor's name or address: the log is append-only and outside every
   * purge, and the work order itself is the record of what it said.
   */
  async send(
    readerPersonId: string,
    issueId: string,
    input: WorkOrderSending,
  ): Promise<WorkOrderView> {
    // Before the transaction opens: creating a queue is the queue backend's
    // own work, on its own connection.
    await this.mailer.ensureQueues();

    const id = await this.prisma.$transaction(async (tx) => {
      const located = await tx.issue.findUnique({
        where: { id: issueId },
        select: { typeId: true },
      });
      if (located !== null) {
        await lockIssueType(tx, located.typeId);
      }
      await lockIssue(tx, issueId);
      await lockWorkOrderSender(tx, readerPersonId);
      await this.contractors.lockForSending(tx, input.contractorId);

      const prepared = await this.prepare(tx, issueId, readerPersonId, input);
      const now = new Date();
      if (
        !previewMatches(
          this.previewKey,
          input.previewToken,
          previewed(issueId, readerPersonId, prepared),
          now,
        )
      ) {
        throw new IssueError(
          "What would be sent is not what was previewed. Preview it again.",
          "work-order-preview-stale",
        );
      }
      await this.refuseRepeat(tx, issueId, readerPersonId, prepared, now);

      const id = randomUUID();
      const recipientEmail = await this.encryption.encrypt(
        "workOrder.recipientEmail",
        prepared.recipient.email,
        id,
      );
      const order = await tx.workOrder
        .create({
          data: {
            id,
            issueId,
            contractorId: prepared.contractorId,
            recipientName: prepared.recipient.name,
            recipientEmailCipher: recipientEmail.cipher,
            body: prepared.body,
            sentByPersonId: readerPersonId,
          },
          select: { id: true },
        })
        .catch(contractorRemoved);

      await this.audit.record(
        {
          action: "ISSUE_WORK_ORDER_SENT",
          channel: "WEB",
          actorPersonId: readerPersonId,
          targetKind: "issue",
          targetId: issueId,
          context: {
            workOrderId: order.id,
            contractorId: prepared.contractorId,
            characters: prepared.body.length,
          },
        },
        tx,
      );

      await this.mailer.enqueueInTransaction(tx, order.id);
      return order.id;
    });

    this.logger.log(`Work order ${id} written on issue ${issueId}`);
    const row = await this.prisma.workOrder.findUniqueOrThrow({
      where: { id },
      select: WORK_ORDER_SELECT,
    });
    const [view] = await this.views([row]);
    if (view === undefined) {
      throw new Error(`Work order ${id} could not be viewed.`);
    }
    return view;
  }

  /**
   * Refuses a second press of the same button, and a handler past their
   * budget. Under the issue's lock and the sender's, so neither is a count two
   * sendings can both pass.
   */
  private async refuseRepeat(
    tx: Prisma.TransactionClient,
    issueId: string,
    readerPersonId: string,
    prepared: { contractorId: string; body: string },
    now: Date,
  ): Promise<void> {
    const repeated = await tx.workOrder.findFirst({
      where: {
        issueId,
        contractorId: prepared.contractorId,
        AND: [
          {
            // The same text, or a work order whose text a handler has since
            // redacted: its text is gone, so a press of the same button cannot
            // be told from a new work order by what it says, and sending
            // again would mail the words the handler removed. Within the
            // preview's life only; a corrected work order is sent when it has
            // passed.
            OR: [
              { body: prepared.body },
              { body: null, redactedAt: { not: null } },
            ],
          },
          {
            // An order known not to have left this instance is not an earlier
            // sending: its handler is told to write it again, and a refusal
            // that says it was sent would be false. One that is unconfirmed
            // may have gone out, and counts.
            OR: [
              { deliveryStatus: { not: "FAILED" } },
              { deliveryFailure: null },
              { deliveryFailure: { notIn: [...WORK_ORDER_NEVER_LEFT] } },
            ],
          },
        ],
        createdAt: {
          gte: new Date(now.getTime() - WORK_ORDER_DUPLICATE_WINDOW_MS),
        },
      },
      select: { id: true },
    });
    if (repeated !== null) {
      throw new IssueError(
        "A work order to this contractor was written a short while ago and may have been sent.",
        "work-order-duplicate",
      );
    }
    const recent = await tx.workOrder.count({
      where: {
        sentByPersonId: readerPersonId,
        createdAt: {
          gte: new Date(now.getTime() - WORK_ORDER_SEND_BUDGET.windowMs),
        },
      },
    });
    if (recent >= WORK_ORDER_SEND_BUDGET.count) {
      throw new IssueError(
        "Too many work orders sent in the last hour.",
        "work-order-budget-spent",
      );
    }
  }

  /**
   * What a preview and a sending both decide: the issue is one the reader
   * handles and not ring-fenced, the contractor is on the list with an
   * address, and the text says something and carries no identity number.
   *
   * The text is folded as the identity-number scan folds it, and that is what
   * is both checked and stored, so what was checked is what is sent.
   */
  private async prepare(
    db: Prisma.TransactionClient | PrismaService,
    issueId: string,
    readerPersonId: string,
    input: WorkOrderInput,
  ): Promise<{
    contractorId: string;
    recipient: { name: string; email: string };
    body: string;
  }> {
    const issue = await this.requireHandled(db, issueId, readerPersonId);
    if (issue.type.ringFenced) {
      throw new IssueError(
        "Nothing about an issue of this type may reach a contractor.",
        "work-order-ring-fenced",
      );
    }
    if (issue.closed) {
      throw new IssueError(
        "A closed issue is reopened before a work order is written.",
        "issue-closed",
      );
    }

    const body = normalizeFreeText(input.body).trim();
    if (body === "") {
      throw new IssueError("The work order is empty.", "work-order-empty");
    }
    if (scanForPersonalIdentityNumbers(body).length > 0) {
      throw new IssueError(
        "Write the work order without a personal identity number in it.",
        "work-order-identity-number",
      );
    }

    const contractor = await this.contractors.active(db, input.contractorId);
    if (contractor === null) {
      throw new IssueError("No such contractor.", "contractor-not-found");
    }
    if (contractor.email === null) {
      throw new IssueError(
        "The list holds no address for this contractor.",
        "contractor-without-email",
      );
    }

    return {
      contractorId: contractor.id,
      recipient: { name: contractor.name, email: contractor.email },
      body,
    };
  }

  /**
   * An issue this person handles, or the refusal that answers an issue that
   * does not exist: one the reader may not open is not one they may learn of.
   */
  private async requireHandled(
    db: Prisma.TransactionClient | PrismaService,
    issueId: string,
    readerPersonId: string,
  ) {
    const scope = await issueReaderScope(db, readerPersonId, new Date());
    const issue = await db.issue.findFirst({
      where: { id: issueId, ...issuesHandledWhere(scope) },
      select: {
        id: true,
        type: { select: { ringFenced: true } },
        status: { select: { meaning: true } },
      },
    });
    if (issue === null) {
      throw new IssueError("No such issue.", "issue-not-found");
    }
    return {
      id: issue.id,
      type: issue.type,
      closed: issue.status.meaning === "DONE",
    };
  }

  private async views(
    rows: WorkOrderRow[],
    linkViews: ReadonlyMap<string, WorkOrderLinkRecordView> = new Map(),
  ): Promise<WorkOrderView[]> {
    const viewOf = await readAuthors(
      this.prisma,
      rows.flatMap((row) =>
        row.sentByPersonId === null ? [] : [row.sentByPersonId],
      ),
    );
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        contractorId: row.contractorId,
        recipientName: row.recipientName,
        recipientEmail: await this.recipientEmail(row),
        body: row.body,
        redactedAt: row.redactedAt?.toISOString() ?? null,
        sentBy: row.sentByPersonId === null ? null : viewOf(row.sentByPersonId),
        sentAt: row.createdAt.toISOString(),
        deliveryStatus: row.deliveryStatus,
        deliveryFailure: row.deliveryFailure as WorkOrderDeliveryFailure | null,
        contractorLink: linkViews.get(row.id) ?? NO_LINK,
      })),
    );
  }

  /**
   * The address a work order was written to, or null when it is erased or
   * cannot be read back: one unreadable address must not take down the list of
   * the others. The failure is logged by name only, never the address or
   * cipher, as a warning: a broken row is met again on every view of the
   * issue, and the work order itself carries the reason it was not sent.
   */
  private async recipientEmail(row: WorkOrderRow): Promise<string | null> {
    if (row.recipientEmailCipher === null) {
      return null;
    }
    try {
      return await this.encryption.decrypt(
        "workOrder.recipientEmail",
        row.recipientEmailCipher,
        row.id,
      );
    } catch (error) {
      this.logger.warn(
        `Work order ${row.id} recipient address could not be read: ${failureName(error)}`,
      );
      return null;
    }
  }
}

/** The link part of a work order nobody has given a link to. */
const NO_LINK: WorkOrderLinkRecordView = {
  link: { state: "none", expiresAt: null },
  answer: null,
  answeredAt: null,
  chosenFileIds: [],
  notes: [],
  files: [],
};

const WORK_ORDER_SELECT = {
  id: true,
  contractorId: true,
  recipientName: true,
  recipientEmailCipher: true,
  body: true,
  redactedAt: true,
  sentByPersonId: true,
  createdAt: true,
  deliveryStatus: true,
  deliveryFailure: true,
} satisfies Prisma.WorkOrderSelect;

type WorkOrderRow = Prisma.WorkOrderGetPayload<{
  select: typeof WORK_ORDER_SELECT;
}>;

/** What a preview signs and a sending is checked against. */
function previewed(
  issueId: string,
  readerPersonId: string,
  prepared: {
    contractorId: string;
    recipient: { name: string; email: string };
    body: string;
  },
): PreviewedWorkOrder {
  return {
    issueId,
    readerPersonId,
    contractorId: prepared.contractorId,
    recipientName: prepared.recipient.name,
    recipientEmail: prepared.recipient.email,
    body: prepared.body,
  };
}

/**
 * A contractor removed from the list between the read above and the insert,
 * which the key to the register then refuses: answered as a contractor not on
 * the list, which by then they are not.
 */
function contractorRemoved(cause: unknown): never {
  if (
    cause instanceof Prisma.PrismaClientKnownRequestError &&
    cause.code === "P2003"
  ) {
    throw new IssueError("No such contractor.", "contractor-not-found");
  }
  throw cause;
}
