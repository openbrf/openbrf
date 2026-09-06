import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { MAX_REPLY_CHARACTERS } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type {
  BoardMailboxDeliveryStatus,
  BoardMailboxMessageDirection,
  BoardMailboxThreadStatus,
} from "../generated/prisma/enums";
import { mediaUrl } from "../media/media.service";
import { BoardMailboxError } from "./board-mailbox.error";
import { BoardMailboxMailerService } from "./board-mailbox-mailer.service";
import { computeBoardMailboxPurgeDate } from "./board-mailbox-retention";
import { loadBoardMailboxSettings } from "./board-mailbox-settings";

/**
 * The board's shared mailbox, as the board works it.
 *
 * Three properties are enforced here rather than left to the screen.
 *
 * **A thread is never attributed to a person.** The correspondent is the address
 * the envelope asserted, decrypted for the board to read and answer, and this
 * service has no path that resolves it to anybody in the register. That is a
 * rule about what mail is: anyone can put anyone's name in a From header, and a
 * platform that turned a letter into a member's word would be inventing a
 * statement nobody made.
 *
 * **Taking a thread is a public act within the board.** The point of a shared
 * mailbox is that the other seats can see who has a letter, so taking one writes
 * a name onto the row every seat reads and an entry into the audit log. Nothing
 * here is exclusive: a second board member can take a thread from the first,
 * because the alternative is a letter locked to somebody on holiday, which is
 * the failure the whole module exists to end.
 *
 * **A reply is sent through the ordinary mail path and recorded either way.** It
 * is written into the thread inside the transaction that queues it, with its
 * delivery pending, and the worker records what the mail server did as a code on
 * that row. A board that pressed send and got a mail server outage has still
 * answered, and its record says so and says the sending failed.
 */

/** The address a letter came from, as the envelope gave it. */
export interface BoardMailboxCorrespondentView {
  email: string;
  /** What the sender called themselves, when they said. Never an identity. */
  name: string | null;
}

/**
 * A board member named on a thread.
 *
 * The issue queue's reporter shape, and for a version of its reason. A person
 * with protected personal data (skyddade personuppgifter) is not named here even
 * though the board's own address book names them: that register has a statutory
 * reason to print a name and this screen has none, and unlike the address book
 * there is no audited reveal behind it. What is lost is that the other seats
 * read "a board member" rather than a name on the one thread that person has
 * taken; what is kept is that this platform does not print a protected person's
 * name on a screen that does not have to. Who sits on the board is in the
 * address book, which is where that question is answered under an audit.
 *
 * `unknown` is a person reference that no longer resolves. Everything here is
 * service tier and a person can be purged out from under a thread, so the screen
 * has to be able to say "we no longer know" rather than break.
 */
export type BoardMemberView =
  | { kind: "member"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

export interface BoardMailboxAttachmentView {
  id: string;
  /** A path on this instance's own origin, never an address at a bucket. */
  url: string;
  fileName: string;
  byteSize: number;
  contentType: string;
}

export interface BoardMailboxMessageView {
  id: string;
  direction: BoardMailboxMessageDirection;
  /** Text, always. Nothing in this module is markup. */
  body: string;
  /** Whether the text was derived from an HTML part rather than sent as text. */
  bodyFromHtml: boolean;
  bodyTruncated: boolean;
  /** Attachments that arrived and were not stored. */
  attachmentsDropped: number;
  occurredAt: string;
  /** Who wrote it, on an outbound reply. Null on an inbound message. */
  sentBy: BoardMemberView | null;
  /** How the sending went, on an outbound reply. Null on an inbound message. */
  delivery: {
    status: BoardMailboxDeliveryStatus;
    /** A failure code, never the mail server's own words. */
    failure: string | null;
    sentAt: string | null;
  } | null;
  attachments: BoardMailboxAttachmentView[];
}

export interface BoardMailboxThreadSummary {
  id: string;
  subject: string;
  correspondent: BoardMailboxCorrespondentView;
  status: BoardMailboxThreadStatus;
  takenBy: BoardMemberView | null;
  lastMessageAt: string;
  messageCount: number;
  /** The date this thread's retention runs out and the purge erases it. */
  erasableFrom: string;
}

export interface BoardMailboxThreadView extends BoardMailboxThreadSummary {
  /**
   * The conversation, oldest first. The newest {@link MAX_MESSAGES_READ} of it
   * when the thread is longer than that; `messageCount` says how long it is.
   */
  messages: BoardMailboxMessageView[];
  /**
   * What to ask for to read the page before this one, or null at the beginning
   * of the conversation. The id of the oldest message on this page: the next
   * page is the messages older than it.
   */
  olderCursor: string | null;
}

/** The inbox, and how to read past it. */
export interface BoardMailboxThreadList {
  threads: BoardMailboxThreadSummary[];
  /** Whether the mailbox holds threads this page does not list. */
  more: boolean;
  /**
   * What to ask for to read the next page, or null when this is the last of
   * them. The id of the last thread on this page.
   */
  nextCursor: string | null;
}

/**
 * The most threads one inbox load lists.
 *
 * How many rows there are is decided outside the association - it is how much
 * mail is sent to an address the board publishes, and the collector's own notes
 * name a mailing list pointed at it as a case to expect - and nothing shrinks
 * the set for two years, which is the retention. So the query is bounded, and
 * the order decides what a bound costs: the inbox is ordered by how much is
 * still owed, so what falls off the end is the far side of CLOSED, which is the
 * work that is finished. The board is told the list is not all of it.
 *
 * Each row costs two decryptions to summarise, which is the other reason not to
 * read a set nobody here chose the size of.
 */
const MAX_THREADS_LISTED = 200;

/**
 * The most messages one thread shows.
 *
 * The newest of them, because a conversation is read at its end and answered
 * from there. A thread's length is decided by a correspondent, and a body runs
 * to 20 000 characters, so this is what keeps one open thread from being a
 * larger read than the whole inbox.
 */
const MAX_MESSAGES_READ = 100;

/** What the board is told about its own mailbox configuration. */
export interface BoardMailboxStatusView {
  /** Whether a mailbox is configured at all. */
  configured: boolean;
  /** The address the board publishes, when one is set. */
  address: string | null;
}

@Injectable()
export class BoardMailboxService {
  private readonly logger = new Logger(BoardMailboxService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
    private readonly mailer: BoardMailboxMailerService,
  ) {}

  /** Whether the mailbox is set up, and which address it answers as. */
  async status(): Promise<BoardMailboxStatusView> {
    const settings = await loadBoardMailboxSettings(
      this.prisma,
      this.encryption,
    );
    return {
      configured: settings !== null,
      address: settings?.address ?? null,
    };
  }

  /**
   * The inbox.
   *
   * Unanswered first and oldest first inside a state, because a shared mailbox is
   * worked from the top and the letter that has been waiting longest is the one
   * to look at. The enumeration's own order does that: NEW, TAKEN, ANSWERED,
   * CLOSED is exactly the order of how much is still owed.
   */
  async listThreads(filter?: {
    status?: BoardMailboxThreadStatus;
    /** The `nextCursor` of the page before this one. */
    after?: string;
  }): Promise<BoardMailboxThreadList> {
    // One row past the bound, which is what says there is a row past it. It is
    // dropped again below rather than shown.
    //
    // The id is on the ordering as well as on the cursor. Two threads can share
    // a status and a last-message time, and a page boundary that falls between
    // them has to fall in the same place every time it is asked for, or a thread
    // is listed twice or not at all.
    const rows = await this.prisma.boardMailboxThread.findMany({
      where: filter?.status === undefined ? {} : { status: filter.status },
      orderBy: [{ status: "asc" }, { lastMessageAt: "asc" }, { id: "asc" }],
      take: MAX_THREADS_LISTED + 1,
      ...(filter?.after === undefined
        ? {}
        : { cursor: { id: filter.after }, skip: 1 }),
      select: {
        ...THREAD_SELECT,
        _count: { select: { messages: true } },
      },
    });

    const more = rows.length > MAX_THREADS_LISTED;
    const threads = more ? rows.slice(0, MAX_THREADS_LISTED) : rows;

    const people = await this.peopleFor(
      threads.map((thread) => thread.takenByPersonId),
    );

    return {
      threads: await Promise.all(
        threads.map(async (thread) => ({
          ...(await this.toSummary(thread, people)),
          messageCount: thread._count.messages,
        })),
      ),
      more,
      nextCursor: more ? (threads[threads.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * One thread, in the order it was said.
   *
   * A page at a time from the newest end, so a board member opening a long
   * conversation lands where it is rather than at its beginning, and the
   * messages before that page are one press away rather than quietly missing.
   * `olderCursor` is what asks for the page before this one.
   *
   * Read newest first and turned back the right way round below, because the
   * page wanted is the last {@link MAX_MESSAGES_READ} and a database counts from
   * the end it is ordered by.
   *
   * @param before The `olderCursor` of the page after this one. Omitted for the
   *   newest page, which is what opening a thread reads.
   */
  async readThread(
    threadId: string,
    before?: string,
  ): Promise<BoardMailboxThreadView> {
    const thread = await this.prisma.boardMailboxThread.findUnique({
      where: { id: threadId },
      select: {
        ...THREAD_SELECT,
        _count: { select: { messages: true } },
        messages: {
          // The id on the ordering for the reason it is on the inbox's: two
          // messages can share an instant, and a page boundary between them has
          // to fall in the same place each time it is asked for.
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: MAX_MESSAGES_READ + 1,
          ...(before === undefined ? {} : { cursor: { id: before }, skip: 1 }),
          select: MESSAGE_SELECT,
        },
      },
    });

    if (thread === null) {
      throw new BoardMailboxError("No such thread.", "thread-not-found");
    }

    const people = await this.peopleFor([
      thread.takenByPersonId,
      ...thread.messages.map((message) => message.sentByPersonId),
    ]);

    const older = thread.messages.length > MAX_MESSAGES_READ;
    const page = older
      ? thread.messages.slice(0, MAX_MESSAGES_READ)
      : thread.messages;

    return {
      ...(await this.toSummary(thread, people)),
      messageCount: thread._count.messages,
      messages: [...page]
        .reverse()
        .map((message) => toMessageView(message, people)),
      olderCursor: older ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Records that a board member is dealing with a thread.
   *
   * Not exclusive, and that is the decision rather than an oversight. A lock
   * would recreate the problem: a letter held by whoever opened it first, who
   * then goes on holiday, is precisely mail stuck with an individual. So taking
   * a thread somebody else holds is allowed, it is written to the audit log with
   * both names, and the screen shows the board what happened.
   */
  async take(
    threadId: string,
    principal: Principal,
  ): Promise<BoardMailboxThreadView> {
    await this.prisma.$transaction(async (tx) => {
      const thread = await tx.boardMailboxThread.findUnique({
        where: { id: threadId },
        select: { id: true, status: true, takenByPersonId: true },
      });
      if (thread === null) {
        throw new BoardMailboxError("No such thread.", "thread-not-found");
      }

      await tx.boardMailboxThread.update({
        where: { id: thread.id },
        data: {
          takenByPersonId: principal.personId,
          takenAt: new Date(),
          // A closed thread that somebody takes on again is open again. An
          // answered one stays answered: taking it says who is following it up,
          // not that the answer was withdrawn.
          status:
            thread.status === "CLOSED"
              ? "TAKEN"
              : thread.status === "NEW"
                ? "TAKEN"
                : thread.status,
          closedAt: thread.status === "CLOSED" ? null : undefined,
          closedByPersonId: thread.status === "CLOSED" ? null : undefined,
        },
      });

      await this.audit.record(
        {
          action: "BOARD_MAILBOX_THREAD_TAKEN",
          actorPersonId: principal.personId,
          // No subject: the correspondent is an address the envelope asserted
          // and is never resolved to a person, so naming one here would be the
          // attribution this module refuses everywhere else.
          targetKind: "boardMailboxThread",
          targetId: thread.id,
          // Facts about the act, and not a word of the letter: the previous
          // holder, so a board can see a thread changing hands.
          context: {
            previousHolderPersonId: thread.takenByPersonId,
            previousStatus: thread.status,
          },
        },
        tx,
      );
    });

    return this.readThread(threadId);
  }

  /** Puts a thread back, so every seat is offered it again. */
  async release(
    threadId: string,
    principal: Principal,
  ): Promise<BoardMailboxThreadView> {
    await this.prisma.$transaction(async (tx) => {
      const thread = await tx.boardMailboxThread.findUnique({
        where: { id: threadId },
        select: { id: true, status: true, takenByPersonId: true },
      });
      if (thread === null) {
        throw new BoardMailboxError("No such thread.", "thread-not-found");
      }

      await tx.boardMailboxThread.update({
        where: { id: thread.id },
        data: {
          takenByPersonId: null,
          takenAt: null,
          // Only a thread that was taken and nothing else goes back to new. One
          // that has been answered keeps saying so: the answer was given, and
          // putting it back in the unclaimed pile would ask the board to answer
          // it again.
          status: thread.status === "TAKEN" ? "NEW" : thread.status,
        },
      });

      await this.audit.record(
        {
          action: "BOARD_MAILBOX_THREAD_RELEASED",
          actorPersonId: principal.personId,
          targetKind: "boardMailboxThread",
          targetId: thread.id,
          context: {
            previousHolderPersonId: thread.takenByPersonId,
            previousStatus: thread.status,
          },
        },
        tx,
      );
    });

    return this.readThread(threadId);
  }

  /**
   * The board's answer.
   *
   * The reply, the thread's new state and the job that sends it commit together
   * or not at all - the meeting notice's rule, and for the same reason. The
   * alternative, sending after the commit, has no way back when it fails: the
   * board has been told its answer went out and nothing is holding the work.
   *
   * Replying takes the thread if nobody had, because pressing send is the
   * clearest possible statement that somebody is dealing with it, and a board
   * that had to press two buttons in order would sometimes press one.
   */
  async reply(
    threadId: string,
    principal: Principal,
    body: string,
  ): Promise<BoardMailboxThreadView> {
    const text = body.trim();
    if (text === "") {
      throw new BoardMailboxError("The reply is empty.", "empty-reply");
    }

    const settings = await loadBoardMailboxSettings(
      this.prisma,
      this.encryption,
    );
    if (settings === null) {
      // Refused rather than queued. An answer sent from an instance with no
      // mailbox configured would go out with no address for the correspondent to
      // reply to, and the conversation would end there without anybody noticing.
      throw new BoardMailboxError(
        "No board mailbox is configured.",
        "mailbox-not-configured",
      );
    }

    // Created before the transaction opens, for the reason the notice mailer
    // creates its queues before its own: the queue backend does its work on its
    // own connection, and creating a queue inside somebody else's transaction
    // would put a schema change in it.
    await this.mailer.ensureQueues();

    await this.prisma.$transaction(async (tx) => {
      const thread = await tx.boardMailboxThread.findUnique({
        where: { id: threadId },
        select: {
          id: true,
          status: true,
          takenByPersonId: true,
          messages: {
            where: { direction: "INBOUND", messageId: { not: null } },
            orderBy: { occurredAt: "desc" },
            take: 1,
            select: { messageId: true },
          },
        },
      });
      if (thread === null) {
        throw new BoardMailboxError("No such thread.", "thread-not-found");
      }
      if (thread.status === "CLOSED") {
        // Stated rather than silently reopening. A board that has recorded
        // itself finished with a matter and then answers it is doing two things,
        // and the screen offers the first of them explicitly - it shows no reply
        // form on a closed thread, so this is the server refusing a control it
        // never offered.
        throw new BoardMailboxError("The thread is closed.", "thread-closed");
      }

      const message = await tx.boardMailboxMessage.create({
        data: {
          threadId: thread.id,
          direction: "OUTBOUND",
          // Generated here rather than left to the mail server, because it has
          // to be on the row before the message exists: it is what the
          // correspondent's client threads the answer against, and what a reply
          // to the reply is matched to when it comes back.
          messageId: this.newMessageId(settings.address),
          inReplyTo: thread.messages[0]?.messageId ?? null,
          body: text.slice(0, MAX_REPLY_CHARACTERS),
          sentByPersonId: principal.personId,
          deliveryStatus: "PENDING",
          occurredAt: new Date(),
        },
        select: { id: true },
      });

      await tx.boardMailboxThread.update({
        where: { id: thread.id },
        data: {
          status: "ANSWERED",
          lastMessageAt: new Date(),
          takenByPersonId: thread.takenByPersonId ?? principal.personId,
          takenAt: thread.takenByPersonId === null ? new Date() : undefined,
        },
      });

      await this.audit.record(
        {
          action: "BOARD_MAILBOX_REPLY_SENT",
          actorPersonId: principal.personId,
          targetKind: "boardMailboxThread",
          targetId: thread.id,
          // The message the entry is about, and how long it was. Not a word of
          // it: the log is append-only and outside every purge, and a copy here
          // would outlive the reply it records by design.
          context: {
            messageId: message.id,
            characters: text.length,
          },
        },
        tx,
      );

      await this.mailer.enqueueInTransaction(tx, message.id);
    });

    return this.readThread(threadId);
  }

  /** Records that the board is finished with a thread, or that it is not. */
  async setClosed(
    threadId: string,
    closed: boolean,
    principal: Principal,
  ): Promise<BoardMailboxThreadView> {
    await this.prisma.$transaction(async (tx) => {
      const thread = await tx.boardMailboxThread.findUnique({
        where: { id: threadId },
        select: {
          id: true,
          status: true,
          takenByPersonId: true,
          messages: {
            where: { direction: "OUTBOUND" },
            take: 1,
            select: { id: true },
          },
        },
      });
      if (thread === null) {
        throw new BoardMailboxError("No such thread.", "thread-not-found");
      }

      await tx.boardMailboxThread.update({
        where: { id: thread.id },
        data: closed
          ? {
              status: "CLOSED",
              closedAt: new Date(),
              closedByPersonId: principal.personId,
            }
          : {
              /*
               * Reopening puts the thread back where it stood, which the row
               * still knows: a thread the board answered goes back to answered,
               * one somebody had taken goes back to taken, and one nobody had
               * touched goes back to new. Reopening everything to new would ask
               * the board to answer letters it had already answered.
               */
              status:
                thread.messages.length > 0
                  ? "ANSWERED"
                  : thread.takenByPersonId === null
                    ? "NEW"
                    : "TAKEN",
              closedAt: null,
              closedByPersonId: null,
            },
      });

      await this.audit.record(
        {
          action: closed
            ? "BOARD_MAILBOX_THREAD_CLOSED"
            : "BOARD_MAILBOX_THREAD_REOPENED",
          actorPersonId: principal.personId,
          targetKind: "boardMailboxThread",
          targetId: thread.id,
          context: { previousStatus: thread.status },
        },
        tx,
      );
    });

    return this.readThread(threadId);
  }

  /**
   * A Message-ID for an outbound reply.
   *
   * The domain half is the board's own address, which is what a receiving mail
   * server expects to see and what makes the identifier globally unique in the
   * way the specification intends. The local half is a random identifier and
   * nothing else: a Message-ID travels in every copy of a message and in every
   * reply to it, so anything derived from a row would be a database identifier
   * published to everyone the board ever writes to.
   */
  private newMessageId(address: string): string {
    const domain = address.split("@")[1] ?? new URL(this.env.APP_URL).hostname;
    return `${randomUUID()}@${domain}`;
  }

  /**
   * The people named on a set of threads, read once.
   *
   * One query rather than one per row, and `protectedPersonalData` is selected
   * because whether a person is named at all depends on it.
   */
  private async peopleFor(
    ids: readonly (string | null)[],
  ): Promise<ReadonlyMap<string, PersonRecord>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) {
      return new Map();
    }
    const people = await this.prisma.person.findMany({
      where: { id: { in: wanted } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        protectedPersonalData: true,
      },
    });
    return new Map(people.map((person) => [person.id, person]));
  }

  private async toSummary(
    thread: ThreadRecord,
    people: ReadonlyMap<string, PersonRecord>,
  ): Promise<Omit<BoardMailboxThreadSummary, "messageCount">> {
    return {
      id: thread.id,
      subject: thread.subject,
      correspondent: {
        email: await this.encryption.decrypt(
          "boardMailboxThread.correspondentEmail",
          thread.correspondentEmailCipher,
        ),
        name:
          thread.correspondentNameCipher === null
            ? null
            : await this.encryption.decrypt(
                "boardMailboxThread.correspondentName",
                thread.correspondentNameCipher,
              ),
      },
      status: thread.status,
      takenBy:
        thread.takenByPersonId === null
          ? null
          : memberView(thread.takenByPersonId, people),
      lastMessageAt: thread.lastMessageAt.toISOString(),
      erasableFrom: computeBoardMailboxPurgeDate(
        thread.lastMessageAt,
      ).toISOString(),
    };
  }
}

interface PersonRecord {
  id: string;
  firstName: string;
  lastName: string;
  protectedPersonalData: boolean;
}

interface ThreadRecord {
  id: string;
  subject: string;
  correspondentEmailCipher: string;
  correspondentNameCipher: string | null;
  status: BoardMailboxThreadStatus;
  takenByPersonId: string | null;
  lastMessageAt: Date;
}

const THREAD_SELECT = {
  id: true,
  subject: true,
  correspondentEmailCipher: true,
  correspondentNameCipher: true,
  status: true,
  takenByPersonId: true,
  lastMessageAt: true,
} as const;

const MESSAGE_SELECT = {
  id: true,
  direction: true,
  body: true,
  bodyFromHtml: true,
  bodyTruncated: true,
  attachmentsDropped: true,
  occurredAt: true,
  sentByPersonId: true,
  deliveryStatus: true,
  deliveryFailure: true,
  sentAt: true,
  attachments: {
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      file: {
        select: {
          id: true,
          fileName: true,
          byteSize: true,
          contentType: true,
        },
      },
    },
  },
} as const;

function memberView(
  personId: string,
  people: ReadonlyMap<string, PersonRecord>,
): BoardMemberView {
  const person = people.get(personId);
  if (person === undefined) {
    return { kind: "unknown" };
  }
  if (person.protectedPersonalData) {
    return { kind: "protected", personId: person.id };
  }
  return {
    kind: "member",
    personId: person.id,
    name: `${person.firstName} ${person.lastName}`.trim(),
  };
}

function toMessageView(
  message: {
    id: string;
    direction: BoardMailboxMessageDirection;
    body: string;
    bodyFromHtml: boolean;
    bodyTruncated: boolean;
    attachmentsDropped: number;
    occurredAt: Date;
    sentByPersonId: string | null;
    deliveryStatus: BoardMailboxDeliveryStatus | null;
    deliveryFailure: string | null;
    sentAt: Date | null;
    attachments: {
      id: string;
      file: {
        id: string;
        fileName: string;
        byteSize: number;
        contentType: string;
      };
    }[];
  },
  people: ReadonlyMap<string, PersonRecord>,
): BoardMailboxMessageView {
  return {
    id: message.id,
    direction: message.direction,
    body: message.body,
    bodyFromHtml: message.bodyFromHtml,
    bodyTruncated: message.bodyTruncated,
    attachmentsDropped: message.attachmentsDropped,
    occurredAt: message.occurredAt.toISOString(),
    sentBy:
      message.sentByPersonId === null
        ? null
        : memberView(message.sentByPersonId, people),
    delivery:
      message.deliveryStatus === null
        ? null
        : {
            status: message.deliveryStatus,
            failure: message.deliveryFailure,
            sentAt: message.sentAt?.toISOString() ?? null,
          },
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      url: mediaUrl(attachment.file.id),
      fileName: attachment.file.fileName,
      byteSize: attachment.file.byteSize,
      contentType: attachment.file.contentType,
    })),
  };
}
