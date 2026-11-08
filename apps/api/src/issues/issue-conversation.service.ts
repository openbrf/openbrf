import { Injectable, Logger } from "@nestjs/common";
import {
  ISSUE_CONVERSATION_LIMITS,
  type IssueSignature,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { databaseNow } from "../database/database-clock";
import { PrismaService } from "../database/prisma.service";
import { readAuthors } from "../feed/feed-author";
import type { Prisma } from "../generated/prisma/client";
import { failureName } from "../logging/failure";
import { holdsBoardSeat } from "../mail/board-recipients";
import { readImageHeader } from "../media/image-bytes";
import { mediaUrl, MediaService } from "../media/media.service";
import { lockErasureEligibility } from "../retention/erasure-lock";
import {
  issueReaderScope,
  issuesHandledWhere,
  requireHandledIssue,
  requireHandledIssueForWrite,
} from "./issue-handlers";
import { lockIssueForHandling, lockIssuesForHandling } from "./issue-lock";
import {
  extendReporterLink,
  liveReporterLinkOfIssue,
} from "./issue-reporter-link";
import { IssueMailer } from "./issue-mailer.service";
import { IssueError, type IssueTextLocation } from "./issue.error";
import { reopenIssueByReply, replyModeOf } from "./issue-reopening";
import type { IssueHandlerView } from "./issue.service";

/**
 * An issue message as the issue's reporter reads it (decisions 18 and 19).
 *
 * A handler's message carries the role it was signed with, the board or the
 * property manager, and never who wrote it: who works an issue is internal
 * (ADR 0054), and a reporter is told no handler's name. Their own messages
 * carry nothing but the text.
 */
export type ReporterIssueMessageView = {
  id: string;
  /** Empty once a handler redacted it. */
  body: string;
  /** When a handler redacted it (ADR 0057), or null while it stands. */
  redactedAt: string | null;
  createdAt: string;
} & ({ side: "REPORTER" } | { side: "HANDLER"; signature: IssueSignature });

/**
 * An issue message as a handler reads it: a handler's with the role it was
 * signed with and who wrote it, as `IssueHandlerView` names them (a protected
 * handler's name withheld, a purged one unknown).
 *
 * The reporter's messages carry no author. The queue row says who reported the
 * issue, masked as a reporter is, and a second spelling of them here would be a
 * second place for a protected reporter's name to escape, as the timeline's
 * comment says of its own steps.
 */
export type HandlerIssueMessageView = {
  id: string;
  /** Empty once a handler redacted it. */
  body: string;
  /** When a handler redacted it (ADR 0057), or null while it stands. */
  redactedAt: string | null;
  createdAt: string;
} & (
  | { side: "REPORTER" }
  | { side: "HANDLER"; signature: IssueSignature; author: IssueHandlerView }
);

/** An internal note, as the handlers read it. */
export interface IssueNoteView {
  id: string;
  author: IssueHandlerView;
  /** Empty once a handler redacted it. */
  body: string;
  /** When a handler redacted it (ADR 0057), or null while it stands. */
  redactedAt: string | null;
  createdAt: string;
}

/** A file the handlers attached to an issue for each other. */
export interface IssueAttachmentView {
  id: string;
  /** A path on this instance's own origin, never an address at a bucket. */
  url: string;
  fileName: string;
  contentType: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

/**
 * The budget of the transaction that writes to every merged reporter.
 *
 * It writes a message and an audit entry per duplicate, and nothing caps how
 * many issues merge into one, so Prisma's default of five seconds could roll
 * back the whole broadcast on a large merged set. It stays one transaction so
 * that the reporters all hear it or none does, and the issue lock it holds is
 * the one merging takes. Thirty seconds, as the reports hold theirs.
 */
const DUPLICATE_MESSAGE_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * How many times that transaction starts over when an issue is merged into the
 * one written from while it takes its locks (`replyToDuplicates`). A merge is a
 * handler's deliberate act, so a second one inside the same moment is rare and
 * a third rarer still.
 */
const DUPLICATE_MESSAGE_ATTEMPTS = 3;

/**
 * The conversation on an issue: the issue messages between its reporter and
 * its handlers, and the internal notes and files the handlers keep beside it
 * (decisions 18 and 19).
 *
 * Its own service beside `IssueService`, reading the same rules from the same
 * places rather than restating them: who handles an issue is
 * `requireHandledIssue`, `IssueService`'s own read, asked of the database on
 * every read and write, so an issue the board keeps to itself keeps its
 * conversation, notes and files with it, and is answered to anybody else as an
 * issue that does not exist. Who reported it is the issue's own
 * `reporterPersonId`, asked the same way.
 *
 * Three things hold here rather than on a screen.
 *
 * - **The reporter never reads a note, a handler's file or a name.** Notes and
 *   files are tables of their own that no reporter's read touches, and a
 *   handler's message reaches the reporter signed with a role (decision 19).
 * - **No row carries a name.** The writer is a person identifier, read and
 *   masked when the conversation is read, so a handler with protected personal
 *   data is named to nobody and an erased one is unknown.
 * - **Text the board writes back is scanned** for personal identity numbers
 *   and refused with where they sit, as a key order's answer and a comment
 *   are. The reporter's own messages are stored as written, as the description
 *   is, for the reason `IssueService` gives.
 *
 * Nothing here is offered to a connected app or to the AI package: no action
 * reads or writes the conversation (ADR 0056). A message is followed by a mail
 * that says there is a new one and carries none of what it says (decision 21,
 * `IssueMailer.messageInTransaction`); a reporter's, only while their hourly
 * budget for messages lasts, and past it the message is stored all the same.
 */
@Injectable()
export class IssueConversationService {
  private readonly logger = new Logger(IssueConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditLogService,
    private readonly mailer: IssueMailer,
  ) {}

  /**
   * The conversation on one's own issue, oldest first. An issue the person did
   * not report is answered as one that does not exist.
   */
  async reporterThread(
    reporterPersonId: string,
    issueId: string,
  ): Promise<ReporterIssueMessageView[]> {
    await this.requireReported(this.prisma, issueId, reporterPersonId);
    const messages = await this.prisma.issueMessage.findMany({
      where: { issueId },
      orderBy: MESSAGE_ORDER,
      select: MESSAGE_SELECT,
    });
    return messages.map(toReporterView);
  }

  /**
   * The reporter writes on their own issue.
   *
   * On an issue that is done, the reopening rule decides (ADR 0054, decision
   * 8). Within `ISSUE_REOPEN_WINDOW_DAYS` of its closing, the reply reopens it:
   * it moves to its type's default in-progress status, its outcome and its
   * closing date are cleared, and the message lands on it, so the reply is
   * one the queue shows is waiting rather than one on a closed issue nobody
   * looks at. Its assignee stays, and is who is told. After the window, and
   * on an issue merged into another, the reply is refused (`issue-closed`)
   * and the reporter's screen offers a new report linked to the old one
   * instead.
   *
   * Under the locks a status move takes (`lockIssueForHandling`), so a reply
   * and a handler's move cannot both decide what the closing date is.
   */
  async replyAsReporter(
    reporterPersonId: string,
    issueId: string,
    body: string,
  ): Promise<ReporterIssueMessageView> {
    let reopened = false;
    // Before the transaction: a queue is made on the backend's own connection.
    await this.mailer.ensureQueues();
    const message = await this.prisma.$transaction(async (tx) => {
      await lockIssueForHandling(tx, issueId);
      const issue = await this.requireReported(tx, issueId, reporterPersonId);
      // The database's clock, after the locks: the window is judged on the
      // clock `closedAt` and a private link's reply are, whichever process
      // answers (`replyModeOf`).
      const mode = replyModeOf(issue, await databaseNow(tx));
      if (mode === "NEW_REPORT") {
        throw new IssueError(
          "This issue is closed and takes no more messages.",
          "issue-closed",
        );
      }
      if (mode === "REOPENS") {
        await reopenIssueByReply(
          { audit: this.audit, mailer: this.mailer },
          tx,
          issue,
          {
            channel: "WEB",
            reporterPersonId,
          },
        );
        reopened = true;
      }
      const written = await tx.issueMessage.create({
        data: {
          issueId,
          side: "REPORTER",
          authorPersonId: reporterPersonId,
          body,
        },
        select: MESSAGE_SELECT,
      });
      await this.recordMessage(tx, written.id, issueId, reporterPersonId);
      await this.mailer.messageInTransaction(tx, issueId, {
        kind: "reporter",
        messageId: written.id,
      });
      return written;
    });

    this.logger.log(
      reopened
        ? `Issue ${issueId} was reopened by a message from its reporter`
        : `Issue ${issueId} has a message from its reporter`,
    );
    return toReporterView(message);
  }

  /**
   * A handler writes to the reporters of every issue merged into this one
   * (decision 22): the same message, signed with the role they write in, on
   * each duplicate's own conversation, which its own reporter alone reads.
   *
   * This is how every reporter of a merged fault still hears from the board.
   * One message per duplicate rather than one shared thread, because the
   * reporters are different people: none of them reads the others' reports,
   * replies or names, and a protected reporter stays masked as on any issue.
   * The handler writes it knowing that it goes to all of them, and it is
   * scanned for a personal identity number as every message is.
   *
   * Only to a duplicate this handler handles, and whose reporter can read a
   * thread, by the rule `replyAsHandler` holds a single message to. Refused
   * with `no-reporter` when there is nobody to read it.
   *
   * Under the handling locks of the issue merged into and of every duplicate,
   * taken together (`lockIssuesForHandling`), so a duplicate the board keeps to
   * itself meanwhile, under its own type's lock, is not written to after the
   * read that found it handled. The duplicates are read unlocked first, to know
   * which locks to take, and again once they are held. The lock of the issue
   * merged into keeps any further merge out from then on, but one may land
   * between the two reads, on a type not locked; the transaction then starts
   * over rather than take that type's lock out of order. Merges landing in the
   * moment of each of `DUPLICATE_MESSAGE_ATTEMPTS` attempts leave a plain
   * `Error` rather than an `IssueError`, deliberately: nothing the handler sent
   * was refused, so the screen shows an unknown failure and the same message
   * can simply be sent again.
   */
  async replyToDuplicates(
    handlerPersonId: string,
    issueId: string,
    body: string,
  ): Promise<{ sent: number; skipped: number }> {
    refusePersonalIdentityNumbers({ body });
    // Before the transaction: a queue is made on the backend's own connection.
    await this.mailer.ensureQueues();
    let result: { sent: number; skipped: number } | null = null;
    for (
      let attempt = 0;
      result === null && attempt < DUPLICATE_MESSAGE_ATTEMPTS;
      attempt += 1
    ) {
      result = await this.prisma.$transaction(
        (tx) => this.writeToDuplicates(tx, handlerPersonId, issueId, body),
        { timeout: DUPLICATE_MESSAGE_TRANSACTION_TIMEOUT_MS },
      );
    }
    if (result === null) {
      // Deliberately not an `IssueError`: it takes a merge landing in the
      // moment of each of the attempts, which is not a refusal of anything the
      // handler sent, and the answer is a failure they can simply repeat.
      throw new Error(
        `Issues kept merging into ${issueId} while a message to their reporters was written.`,
      );
    }

    this.logger.log(
      `Issue ${issueId} has a message to the reporters of ${result.sent} duplicates`,
    );
    return result;
  }

  /**
   * One attempt at `replyToDuplicates`: `null` when an issue was merged into
   * this one between the unlocked read and the locks, which the caller answers
   * by starting over.
   */
  private async writeToDuplicates(
    tx: Prisma.TransactionClient,
    handlerPersonId: string,
    issueId: string,
    body: string,
  ): Promise<{ sent: number; skipped: number } | null> {
    await lockErasureEligibility(tx, handlerPersonId);
    const candidates = await tx.issue.findMany({
      where: { mergedIntoIssueId: issueId },
      select: { id: true },
    });
    const locked = new Set(candidates.map((candidate) => candidate.id));
    await lockIssuesForHandling(tx, [issueId, ...locked]);
    // Read the clock after the lock waits: a board seat that ended during one
    // must not leave board-only duplicates in reach or the signature on BOARD.
    const now = new Date();
    // The role is asked with the scope: the signature below would sign for a
    // person who handles nothing as the board.
    await this.requireHandledForWrite(tx, issueId, handlerPersonId, now);
    const merged = await tx.issue.findMany({
      where: { mergedIntoIssueId: issueId },
      select: { id: true },
    });
    if (merged.some((duplicate) => !locked.has(duplicate.id))) {
      return null;
    }
    const scope = await issueReaderScope(tx, handlerPersonId, now);
    const duplicates = await tx.issue.findMany({
      where: {
        mergedIntoIssueId: issueId,
        ...issuesHandledWhere(scope),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, reporterPersonId: true },
    });
    // A duplicate with no reporter, or one without an account, is reached by
    // nobody; both count as skipped, so the total matches the merged reports.
    const accounts = await tx.user.findMany({
      where: {
        personId: {
          in: duplicates.flatMap((duplicate) =>
            duplicate.reporterPersonId === null
              ? []
              : [duplicate.reporterPersonId],
          ),
        },
      },
      select: { personId: true },
    });
    const readers = new Set(accounts.map((account) => account.personId));
    const readable = duplicates.filter(
      (duplicate) =>
        duplicate.reporterPersonId !== null &&
        readers.has(duplicate.reporterPersonId),
    );
    if (readable.length === 0) {
      throw new IssueError(
        "Nobody can read an answer on the issues merged into this one.",
        "no-reporter",
      );
    }
    const signature = await signatureOf(tx, handlerPersonId, now);
    for (const duplicate of readable) {
      const written = await tx.issueMessage.create({
        data: {
          issueId: duplicate.id,
          side: "HANDLER",
          authorPersonId: handlerPersonId,
          signature,
          body,
        },
        select: { id: true },
      });
      await this.recordMessage(tx, written.id, duplicate.id, handlerPersonId);
      await this.mailer.messageInTransaction(tx, duplicate.id, {
        kind: "handler",
        personId: handlerPersonId,
        messageId: written.id,
      });
    }
    return {
      sent: readable.length,
      skipped: duplicates.length - readable.length,
    };
  }

  /** The conversation with the reporter, as a handler reads it. */
  async handlerThread(
    readerPersonId: string,
    issueId: string,
  ): Promise<HandlerIssueMessageView[]> {
    const messages = await this.readHandled(issueId, readerPersonId, (tx) =>
      tx.issueMessage.findMany({
        where: { issueId },
        orderBy: MESSAGE_ORDER,
        select: MESSAGE_SELECT,
      }),
    );
    return this.handlerViews(messages);
  }

  /**
   * A handler writes to the reporter, signed with the role they write in
   * (decision 19).
   *
   * Refused on an issue nobody can read the answer on (`no-reporter`), rather
   * than stored as a message to nobody. A reporter with an account reads the
   * conversation signed in; one who left an email address on the website's form
   * reads it through the private link mailed to them, while that link opens
   * the issue (ADR 0055). A report with no address, one whose link was never
   * mailed, withdrawn or has ended, and one whose reporter was purged have
   * nobody to write to. A reporter with an account is mailed that there is a
   * new message, never what it says (decision 21); one reading through the
   * private link is not, as the link is mailed once. The issue lets
   * the writer in under the locks a handling write takes
   * (`lockIssueForHandling`), so a message never lands on an issue the board
   * took to itself while it was written, and a link withdrawn meanwhile is
   * read as withdrawn.
   */
  async replyAsHandler(
    handlerPersonId: string,
    issueId: string,
    body: string,
  ): Promise<HandlerIssueMessageView> {
    refusePersonalIdentityNumbers({ body });
    // Before the transaction: a queue is made on the backend's own connection.
    await this.mailer.ensureQueues();
    const message = await this.prisma.$transaction(async (tx) => {
      await lockErasureEligibility(tx, handlerPersonId);
      await lockIssueForHandling(tx, issueId);
      // Read the clock after the lock waits, as the message to duplicates does:
      // a board seat that ended during one must not leave the message signed
      // as the board. One instant for access and for the signature.
      const now = new Date();
      // The role is asked with the scope: the signature below would sign for
      // a person who handles nothing as the board.
      const issue = await this.requireHandledForWrite(
        tx,
        issueId,
        handlerPersonId,
        now,
      );
      // A person with no sign-in account cannot open the conversation either.
      const reporterAccount =
        issue.reporterPersonId === null
          ? null
          : await tx.user.findUnique({
              where: { personId: issue.reporterPersonId },
              select: { id: true },
            });
      const link =
        issue.reporterPersonId === null
          ? await liveReporterLinkOfIssue(tx, issueId)
          : null;
      if (reporterAccount === null && link === null) {
        throw new IssueError(
          "Nobody can read an answer on this issue.",
          "no-reporter",
        );
      }
      const written = await tx.issueMessage.create({
        data: {
          issueId,
          side: "HANDLER",
          authorPersonId: handlerPersonId,
          signature: await signatureOf(tx, handlerPersonId, now),
          body,
        },
        select: MESSAGE_SELECT,
      });
      if (link !== null) {
        // A conversation going on keeps the reporter's way to it open.
        await extendReporterLink(tx, link.linkId);
      }
      await this.recordMessage(tx, written.id, issueId, handlerPersonId);
      await this.mailer.messageInTransaction(tx, issueId, {
        kind: "handler",
        personId: handlerPersonId,
        messageId: written.id,
      });
      return written;
    });

    this.logger.log(`Issue ${issueId} has a message from a handler`);
    const [view] = await this.handlerViews([message]);
    if (view === undefined) {
      throw new Error(`Message ${message.id} could not be viewed.`);
    }
    return view;
  }

  /** The handlers' notes on an issue, oldest first. */
  async notes(
    readerPersonId: string,
    issueId: string,
  ): Promise<IssueNoteView[]> {
    const notes = await this.readHandled(issueId, readerPersonId, (tx) =>
      tx.issueNote.findMany({
        where: { issueId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: NOTE_SELECT,
      }),
    );
    return this.noteViews(notes);
  }

  /** A handler writes a note for the other handlers on the issue. */
  async addNote(
    handlerPersonId: string,
    issueId: string,
    body: string,
  ): Promise<IssueNoteView> {
    refusePersonalIdentityNumbers({ body });
    const note = await this.prisma.$transaction(async (tx) => {
      await lockErasureEligibility(tx, handlerPersonId);
      await lockIssueForHandling(tx, issueId);
      const now = new Date();
      await this.requireHandledForWrite(tx, issueId, handlerPersonId, now);
      const written = await tx.issueNote.create({
        data: { issueId, authorPersonId: handlerPersonId, body },
        select: NOTE_SELECT,
      });
      await this.audit.record(
        {
          action: "ISSUE_NOTE_ADDED",
          channel: "WEB",
          actorPersonId: handlerPersonId,
          targetKind: "issue",
          targetId: issueId,
          // Which note, never what it says.
          context: { noteId: written.id },
        },
        tx,
      );
      return written;
    });

    this.logger.log(`Issue ${issueId} has a new internal note`);
    const [view] = await this.noteViews([note]);
    if (view === undefined) {
      throw new Error(`Note ${note.id} could not be viewed.`);
    }
    return view;
  }

  /** The files the handlers attached to an issue, in the order attached. */
  async attachments(
    readerPersonId: string,
    issueId: string,
  ): Promise<IssueAttachmentView[]> {
    const attachments = await this.readHandled(issueId, readerPersonId, (tx) =>
      tx.issueAttachment.findMany({
        where: { issueId },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: ATTACHMENT_SELECT,
      }),
    );
    return attachments.map(toAttachmentView);
  }

  /**
   * A handler attaches a file to an issue for the other handlers: an image, or
   * a PDF such as a quote or a protocol.
   *
   * The file goes through the media layer like every other: identified from
   * its own bytes, its image metadata stripped, sealed under a key of its own
   * and served from this instance's origin. INTERNAL under `issues:handle`, and
   * read by the issue that links it (`issueFileAccess`), so neither the
   * reporter nor a handler the board-only rule shuts out reads it, whoever
   * holds its address.
   *
   * Whether the bytes are an image decides which reader identifies them, and
   * the media layer then identifies them again on its own.
   */
  async attach(input: {
    issueId: string;
    handlerPersonId: string;
    bytes: Buffer;
    fileName: string;
  }): Promise<IssueAttachmentView> {
    const existing = await this.requireHandled(
      this.prisma,
      input.issueId,
      input.handlerPersonId,
    );
    if (existing._count.attachments >= ISSUE_CONVERSATION_LIMITS.attachments) {
      throw tooManyAttachments();
    }

    const image = readImageHeader(input.bytes) !== null;
    const file = await this.media.upload({
      bytes: input.bytes,
      fileName: input.fileName,
      accept: image ? "image" : "document",
      visibility: "INTERNAL",
      // Whoever handles the issue, through the issue: see MediaService.open.
      requiredCapability: "issues:handle",
      // Declared true without asking, for the reason a reporter's photograph
      // is: nobody knows whether it caught a person, and it is never published.
      ...(image ? { showsIdentifiablePersons: true } : {}),
      uploadedByPersonId: input.handlerPersonId,
      channel: "WEB",
      // A handler's file name is free text about a case, a person's health or
      // home among it. The audit log is append-only and outlives the issue.
      recordFileName: false,
    });

    /*
     * Counted again under the locks a handling write takes, for the reason a
     * reporter's photograph is: uploads sent together all pass the count above,
     * and only a count each takes in turn holds the bound. The writer is asked
     * again too, so a file never lands on an issue the board took to itself
     * during the upload.
     */
    let attachment: Prisma.IssueAttachmentGetPayload<{
      select: typeof ATTACHMENT_SELECT;
    }>;
    try {
      attachment = await this.prisma.$transaction(async (tx) => {
        // No erasure lock, unlike a note: the attachment row names nobody, and
        // the file's uploader was written by the upload above, on its own.
        // The lock orders a row the person purge detaches from its writer
        // against that purge, and this transaction writes none.
        await lockIssueForHandling(tx, input.issueId);
        await this.requireHandledForWrite(
          tx,
          input.issueId,
          input.handlerPersonId,
          new Date(),
        );
        const count = await tx.issueAttachment.count({
          where: { issueId: input.issueId },
        });
        if (count >= ISSUE_CONVERSATION_LIMITS.attachments) {
          throw tooManyAttachments();
        }
        return tx.issueAttachment.create({
          data: { issueId: input.issueId, fileId: file.id, sortOrder: count },
          select: ATTACHMENT_SELECT,
        });
      });
    } catch (cause) {
      // The upload and this removal are both in the audit log, which is the
      // honest record of what happened; the original failure is the one raised.
      await this.media
        .remove(file.id, input.handlerPersonId, "WEB", {
          recordFileName: false,
        })
        .catch((removal: unknown) => {
          this.logger.error(
            `Could not remove file ${file.id} after its attachment was refused: ` +
              failureName(removal),
          );
        });
      throw cause;
    }

    this.logger.log(`Issue ${input.issueId} has a new handler's file`);
    return toAttachmentView(attachment);
  }

  /**
   * Reads something an issue holds for its handlers, after asking whether the
   * reader handles it, from one snapshot.
   *
   * Two statements at READ COMMITTED each take a snapshot of their own, so a
   * board-only change or a handover that committed between the check and the
   * read would let the read return rows the check had not been made for. At
   * REPEATABLE READ the snapshot is taken at the check, and the read cannot
   * see a later one.
   */
  private async readHandled<T>(
    issueId: string,
    readerPersonId: string,
    read: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.requireHandled(tx, issueId, readerPersonId);
        return read(tx);
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  /**
   * An issue this person reported, or the refusal that answers an issue that
   * does not exist.
   */
  private async requireReported(
    db: Prisma.TransactionClient | PrismaService,
    issueId: string,
    reporterPersonId: string,
  ) {
    const issue = await db.issue.findFirst({
      where: { id: issueId, reporterPersonId },
      select: {
        id: true,
        typeId: true,
        closedAt: true,
        mergedIntoIssueId: true,
        status: { select: { id: true, meaning: true } },
      },
    });
    if (issue === null) {
      throw new IssueError("No such issue.", "issue-not-found");
    }
    return issue;
  }

  /** An issue this person handles (`requireHandledIssue`). */
  private async requireHandled(
    db: Prisma.TransactionClient | PrismaService,
    issueId: string,
    readerPersonId: string,
    now: Date = new Date(),
  ) {
    return requireHandledIssue(
      db,
      issueId,
      readerPersonId,
      HANDLED_ISSUE_SELECT,
      now,
    );
  }

  /**
   * The same issue for a write, once its locks are held: the writer's
   * `issues:handle` role is asked at the same instant as their scope
   * (`requireHandledIssueForWrite`), so a write cannot leave it out.
   */
  private async requireHandledForWrite(
    tx: Prisma.TransactionClient,
    issueId: string,
    writerPersonId: string,
    now: Date,
  ) {
    return requireHandledIssueForWrite(
      tx,
      issueId,
      writerPersonId,
      HANDLED_ISSUE_SELECT,
      now,
    );
  }

  /**
   * The entry for a message, with its writer as the actor, which is how the
   * writer's own access report answers for it (ADR 0057).
   */
  private async recordMessage(
    tx: Prisma.TransactionClient,
    messageId: string,
    issueId: string,
    authorPersonId: string,
  ): Promise<void> {
    await this.audit.record(
      {
        action: "ISSUE_MESSAGE_SENT",
        channel: "WEB",
        actorPersonId: authorPersonId,
        targetKind: "issue",
        targetId: issueId,
        // Which message, never what it says. No target person: a handler's
        // entry on the reporter's own report would name the handler to them.
        context: { messageId },
      },
      tx,
    );
  }

  private async handlerViews(
    messages: readonly MessageRecord[],
  ): Promise<HandlerIssueMessageView[]> {
    const viewOf = await readAuthors(
      this.prisma,
      messages
        .filter((message) => message.side === "HANDLER")
        .map((message) => message.authorPersonId),
    );
    return messages.map((message) => {
      const base = {
        id: message.id,
        body: message.body,
        redactedAt: message.redactedAt?.toISOString() ?? null,
        createdAt: message.createdAt.toISOString(),
      };
      if (message.side === "REPORTER" || message.signature === null) {
        return { ...base, side: "REPORTER" as const };
      }
      return {
        ...base,
        side: "HANDLER" as const,
        signature: message.signature,
        author: authorOf(message.authorPersonId, viewOf),
      };
    });
  }

  private async noteViews(
    notes: readonly NoteRecord[],
  ): Promise<IssueNoteView[]> {
    const viewOf = await readAuthors(
      this.prisma,
      notes.map((note) => note.authorPersonId),
    );
    return notes.map((note) => ({
      id: note.id,
      author: authorOf(note.authorPersonId, viewOf),
      body: note.body,
      redactedAt: note.redactedAt?.toISOString() ?? null,
      createdAt: note.createdAt.toISOString(),
    }));
  }
}

/**
 * The role a handler writes to a reporter in (decision 19), as they are now.
 *
 * The board when they hold a seat today. The property manager when they hold
 * that role and no seat. Otherwise, an administrator without a seat, the board:
 * an administrator acts for the association, and a reporter has no third role
 * to be told. A property manager who is also an administrator writes as the
 * property manager, which is the role they hold toward the house; one with a
 * seat writes as the board.
 */
export async function signatureOf(
  db: Prisma.TransactionClient | PrismaService,
  personId: string,
  now: Date,
): Promise<IssueSignature> {
  if (await holdsBoardSeat(db, personId, now)) {
    return "BOARD";
  }
  const manager = await db.person.findFirst({
    where: {
      id: personId,
      systemRoles: { some: { role: "PROPERTY_MANAGER" } },
    },
    select: { id: true },
  });
  return manager === null ? "BOARD" : "PROPERTY_MANAGER";
}

/**
 * Refuses text the board writes back that carries a personal identity number,
 * with where it sits and never the value: the rule a key order's answer, a
 * comment and a motion live under, for their reason. A message is read by the
 * reporter, and a number pasted into it is a copy the register cannot account
 * for.
 */
export function refusePersonalIdentityNumbers(
  parts: Partial<Record<IssueTextLocation["part"], string>>,
): void {
  const locations: IssueTextLocation[] = [];
  for (const [part, text] of Object.entries(parts)) {
    if (text === undefined) {
      continue;
    }
    for (const hit of scanForPersonalIdentityNumbers(text)) {
      locations.push({
        part: part as IssueTextLocation["part"],
        offset: hit.index,
      });
    }
  }
  if (locations.length > 0) {
    throw new IssueError(
      "The text carries a personal identity number and cannot be stored.",
      "personal-identity-number",
      locations,
    );
  }
}

function tooManyAttachments(): IssueError {
  return new IssueError(
    "This issue already carries as many files as it may.",
    "too-many-attachments",
  );
}

/** A writer as a handler is told of them; a purged one is unknown. */
function authorOf(
  personId: string | null,
  viewOf: (id: string) => IssueHandlerView,
): IssueHandlerView {
  return personId === null ? { kind: "unknown" } : viewOf(personId);
}

/** Oldest first, with the identifier to order two written at one instant. */
const MESSAGE_ORDER = [
  { createdAt: "asc" },
  { id: "asc" },
] as const satisfies Prisma.IssueMessageOrderByWithRelationInput[];

const MESSAGE_SELECT = {
  id: true,
  side: true,
  authorPersonId: true,
  signature: true,
  body: true,
  redactedAt: true,
  createdAt: true,
} as const;

type MessageRecord = Prisma.IssueMessageGetPayload<{
  select: typeof MESSAGE_SELECT;
}>;

/** What the conversation reads of an issue it lets a handler write to. */
const HANDLED_ISSUE_SELECT = {
  id: true,
  reporterPersonId: true,
  _count: { select: { attachments: true } },
} as const satisfies Prisma.IssueSelect;

const NOTE_SELECT = {
  id: true,
  authorPersonId: true,
  body: true,
  redactedAt: true,
  createdAt: true,
} as const;

type NoteRecord = Prisma.IssueNoteGetPayload<{ select: typeof NOTE_SELECT }>;

const ATTACHMENT_SELECT = {
  id: true,
  createdAt: true,
  file: {
    select: {
      id: true,
      fileName: true,
      contentType: true,
      width: true,
      height: true,
    },
  },
} as const;

/**
 * A message as its reporter reads it: the writer's role on a handler's, and
 * no person on either. Built from the columns alone, so there is no person on
 * the row to leak.
 */
export function toReporterView(
  message: MessageRecord,
): ReporterIssueMessageView {
  const base = {
    id: message.id,
    body: message.body,
    redactedAt: message.redactedAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
  };
  return message.side === "HANDLER" && message.signature !== null
    ? { ...base, side: "HANDLER", signature: message.signature }
    : { ...base, side: "REPORTER" };
}

function toAttachmentView(
  attachment: Prisma.IssueAttachmentGetPayload<{
    select: typeof ATTACHMENT_SELECT;
  }>,
): IssueAttachmentView {
  return {
    id: attachment.id,
    url: mediaUrl(attachment.file.id),
    fileName: attachment.file.fileName,
    contentType: attachment.file.contentType,
    width: attachment.file.width,
    height: attachment.file.height,
    createdAt: attachment.createdAt.toISOString(),
  };
}
