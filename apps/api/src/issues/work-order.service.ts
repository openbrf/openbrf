import { Injectable, Logger } from "@nestjs/common";
import {
  normalizeFreeText,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { readAuthors } from "../feed/feed-author";
import { Prisma } from "../generated/prisma/client";
import { MailService } from "../mail/mail.service";
import { ContractorService } from "./contractor.service";
import { issueReaderScope, issuesHandledWhere } from "./issue-handlers";
import { lockIssue, lockIssueType } from "./issue-lock";
import type { IssueHandlerView } from "./issue.service";
import { IssueError } from "./issue.error";
import type { WorkOrderDeliveryFailure } from "./work-order-delivery";
import { WorkOrderMailerService } from "./work-order-mailer.service";

/** What a handler writes: whom to, and the job in their own words. */
export interface WorkOrderInput {
  contractorId: string;
  body: string;
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
}

/**
 * One work order on an issue, as its handlers read the record: whom it went
 * to, when, what it said, who sent it, and whether the mail went out.
 */
export interface WorkOrderView {
  id: string;
  /** The contractor on the list, or null once they were removed from it. */
  contractorId: string | null;
  recipientName: string;
  recipientEmail: string;
  body: string;
  sentBy: IssueHandlerView | null;
  sentAt: string;
  deliveryStatus: "PENDING" | "SENT" | "FAILED";
  deliveryFailure: WorkOrderDeliveryFailure | null;
}

export interface IssueWorkOrdersView {
  /**
   * Whether nothing about the issue may reach a contractor (ADR 0055). The
   * screen offers no work order then; the record of any sent before is still
   * listed.
   */
  ringFenced: boolean;
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    private readonly mailer: WorkOrderMailerService,
    private readonly contractors: ContractorService,
  ) {}

  /** The work orders on an issue the reader handles, oldest first. */
  async list(
    readerPersonId: string,
    issueId: string,
  ): Promise<IssueWorkOrdersView> {
    const issue = await this.requireHandled(
      this.prisma,
      issueId,
      readerPersonId,
    );
    const rows = await this.prisma.workOrder.findMany({
      where: { issueId: issue.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: WORK_ORDER_SELECT,
    });
    return {
      ringFenced: issue.type.ringFenced,
      workOrders: await this.views(rows),
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
   * The audit entry names the handler, the issue, the work order and the
   * contractor, and how long the text was. Never a word of it, and never the
   * contractor's name or address: the log is append-only and outside every
   * purge, and the work order itself is the record of what it said.
   */
  async send(
    readerPersonId: string,
    issueId: string,
    input: WorkOrderInput,
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

      const prepared = await this.prepare(tx, issueId, readerPersonId, input);
      const recipientEmail = await this.encryption.encrypt(
        "workOrder.recipientEmail",
        prepared.recipient.email,
      );
      const order = await tx.workOrder
        .create({
          data: {
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
      select: { id: true, type: { select: { ringFenced: true } } },
    });
    if (issue === null) {
      throw new IssueError("No such issue.", "issue-not-found");
    }
    return issue;
  }

  private async views(rows: WorkOrderRow[]): Promise<WorkOrderView[]> {
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
        recipientEmail: await this.encryption.decrypt(
          "workOrder.recipientEmail",
          row.recipientEmailCipher,
        ),
        body: row.body,
        sentBy: row.sentByPersonId === null ? null : viewOf(row.sentByPersonId),
        sentAt: row.createdAt.toISOString(),
        deliveryStatus: row.deliveryStatus,
        deliveryFailure: row.deliveryFailure as WorkOrderDeliveryFailure | null,
      })),
    );
  }
}

const WORK_ORDER_SELECT = {
  id: true,
  contractorId: true,
  recipientName: true,
  recipientEmailCipher: true,
  body: true,
  sentByPersonId: true,
  createdAt: true,
  deliveryStatus: true,
  deliveryFailure: true,
} satisfies Prisma.WorkOrderSelect;

type WorkOrderRow = Prisma.WorkOrderGetPayload<{
  select: typeof WORK_ORDER_SELECT;
}>;

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
