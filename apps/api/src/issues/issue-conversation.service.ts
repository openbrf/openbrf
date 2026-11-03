import { Injectable, Logger } from "@nestjs/common";
import {
  ISSUE_CONVERSATION_LIMITS,
  type IssueSignature,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import { readAuthors } from "../feed/feed-author";
import type { Prisma } from "../generated/prisma/client";
import { failureName } from "../logging/failure";
import { holdsBoardSeat } from "../mail/board-recipients";
import { readImageHeader } from "../media/image-bytes";
import { mediaUrl, MediaService } from "../media/media.service";
import { issueReaderScope, issuesHandledWhere } from "./issue-handlers";
import { lockIssue, lockIssueForHandling } from "./issue-lock";
import { IssueError, type IssueTextLocation } from "./issue.error";
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
  body: string;
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
  body: string;
  createdAt: string;
} & (
  | { side: "REPORTER" }
  | { side: "HANDLER"; signature: IssueSignature; author: IssueHandlerView }
);

/** An internal note, as the handlers read it. */
export interface IssueNoteView {
  id: string;
  author: IssueHandlerView;
  body: string;
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
 * The conversation on an issue: the issue messages between its reporter and
 * its handlers, and the internal notes and files the handlers keep beside it
 * (decisions 18 and 19).
 *
 * Its own service beside `IssueService`, reading the same rules from the same
 * places rather than restating them: who handles an issue is
 * `issueReaderScope` and `issuesHandledWhere`, asked of the database on every
 * read and write, so an issue the board keeps to itself keeps its
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
 * reads or writes the conversation (ADR 0056), and nothing is mailed from here
 * (decision 21).
 */
@Injectable()
export class IssueConversationService {
  private readonly logger = new Logger(IssueConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditLogService,
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
   * Refused on an issue that is done: whether a reply reopens it, or offers a
   * new report instead, is the reopening rule's (ADR 0054), and until that is
   * built a message on a closed issue would be one nobody is shown is waiting.
   * Under the issue's lock, which a status move takes too, so a message cannot
   * land on an issue closing at the same moment.
   */
  async replyAsReporter(
    reporterPersonId: string,
    issueId: string,
    body: string,
  ): Promise<ReporterIssueMessageView> {
    const message = await this.prisma.$transaction(async (tx) => {
      await lockIssue(tx, issueId);
      const issue = await this.requireReported(tx, issueId, reporterPersonId);
      if (issue.status.meaning === "DONE") {
        throw new IssueError(
          "This issue is closed and takes no more messages.",
          "issue-closed",
        );
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
      return written;
    });

    this.logger.log(`Issue ${issueId} has a message from its reporter`);
    return toReporterView(message);
  }

  /** The conversation with the reporter, as a handler reads it. */
  async handlerThread(
    readerPersonId: string,
    issueId: string,
  ): Promise<HandlerIssueMessageView[]> {
    await this.requireHandled(this.prisma, issueId, readerPersonId);
    const messages = await this.prisma.issueMessage.findMany({
      where: { issueId },
      orderBy: MESSAGE_ORDER,
      select: MESSAGE_SELECT,
    });
    return this.handlerViews(messages);
  }

  /**
   * A handler writes to the reporter, signed with the role they write in
   * (decision 19).
   *
   * Refused on an issue nobody can read the answer on (`no-reporter`), rather
   * than stored as a message to nobody. The issue lets the writer in under the
   * locks a handling write takes (`lockIssueForHandling`), so a message never
   * lands on an issue the board took to itself while it was written.
   */
  async replyAsHandler(
    handlerPersonId: string,
    issueId: string,
    body: string,
  ): Promise<HandlerIssueMessageView> {
    refusePersonalIdentityNumbers({ body });
    const message = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await lockIssueForHandling(tx, issueId);
      const issue = await this.requireHandled(tx, issueId, handlerPersonId);
      if (
        issue.reporterPersonId === null &&
        issue.reporterEmailCipher === null
      ) {
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
      await this.recordMessage(tx, written.id, issueId, handlerPersonId);
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
    await this.requireHandled(this.prisma, issueId, readerPersonId);
    const notes = await this.prisma.issueNote.findMany({
      where: { issueId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: NOTE_SELECT,
    });
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
      await lockIssueForHandling(tx, issueId);
      await this.requireHandled(tx, issueId, handlerPersonId);
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
    await this.requireHandled(this.prisma, issueId, readerPersonId);
    const attachments = await this.prisma.issueAttachment.findMany({
      where: { issueId },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: ATTACHMENT_SELECT,
    });
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
        await lockIssueForHandling(tx, input.issueId);
        await this.requireHandled(tx, input.issueId, input.handlerPersonId);
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
        .remove(file.id, input.handlerPersonId, "WEB")
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
      select: { id: true, status: { select: { meaning: true } } },
    });
    if (issue === null) {
      throw new IssueError("No such issue.", "issue-not-found");
    }
    return issue;
  }

  /**
   * An issue this person handles, or the refusal that answers an issue that
   * does not exist: one the reader may not open is not one they may learn of.
   * The rule `IssueService` reads every issue by.
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
        reporterPersonId: true,
        reporterEmailCipher: true,
        _count: { select: { attachments: true } },
      },
    });
    if (issue === null) {
      throw new IssueError("No such issue.", "issue-not-found");
    }
    return issue;
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
  createdAt: true,
} as const;

type MessageRecord = Prisma.IssueMessageGetPayload<{
  select: typeof MESSAGE_SELECT;
}>;

const NOTE_SELECT = {
  id: true,
  authorPersonId: true,
  body: true,
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
function toReporterView(message: MessageRecord): ReporterIssueMessageView {
  const base = {
    id: message.id,
    body: message.body,
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
