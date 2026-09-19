import { Injectable, Logger } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import type { ChatKind } from "../generated/prisma/enums";
import { activeBoardSeatWhere } from "../mail/board-recipients";
import { ChatError, type ChatTextLocation } from "./chat.error";

/**
 * The longest message this application stores.
 *
 * The same cap a news comment carries, and the same reasoning: bounded but
 * generous, so that one write cannot put a megabyte of text in front of
 * everybody in the room, and long enough that somebody explaining why the roof
 * quote is too high does not have to send it in instalments.
 *
 * Enforced by the controller's schema as the body arrives, and stated here so
 * the rule and the type that carries it are one decision.
 */
export const CHAT_MESSAGE_MAX_LENGTH = 2000;

/**
 * How many messages one person may write in {@link WRITE_WINDOW_MINUTES}.
 *
 * Counted from the rows themselves rather than from an in-memory bucket, on the
 * news comment budget's precedent: every caller here is signed in, so the budget
 * can belong to the account, and a count taken from the table survives a restart
 * and is the same budget in every process.
 *
 * Sixty in ten minutes rather than the comment thread's twenty, because a chat
 * is a conversation and a comment thread is not. Six a minute sustained is
 * faster than anybody discussing a roof quote types and far below what a script
 * would want, and the number is high enough that the budget never shows in a
 * real exchange - which is the point: it is here to stop one account writing
 * all afternoon, not to pace a discussion.
 *
 * A throttle on sustained writing rather than a hard ceiling, exactly as the
 * comment budget is. The count is one statement and the insert another, so
 * requests in flight together can each read the same count and each write, and
 * the window ends up over by however many were in flight. Closing that would
 * take SERIALIZABLE or a per-person lock on every message written, to bound an
 * overshoot of a handful among people who all hold a board seat.
 */
export const MESSAGES_PER_WRITE_WINDOW = 60;

/** The window {@link MESSAGES_PER_WRITE_WINDOW} is counted over. */
export const WRITE_WINDOW_MINUTES = 10;

/**
 * How many messages one read of a room answers with.
 *
 * The read has to be bounded, because nothing else bounds it: a room has no end
 * and a message holds up to {@link CHAT_MESSAGE_MAX_LENGTH} characters, so an
 * unbounded read would hand somebody opening the screen a year of the board's
 * deliberation in one payload.
 *
 * The same number bounds the poll. A screen that was closed for a week must not
 * ask for a week of messages in one response, and the poll answers with a page
 * and a flag saying more is waiting rather than with everything since the
 * cursor - so catching up is several small reads instead of one that times out.
 *
 * Fifty, which is more than a room reaches between two glances at the screen and
 * small enough that one payload stays small on the day it does.
 */
export const MESSAGES_PER_PAGE = 50;

/**
 * Where a page of a room ends, as one value a reader hands back.
 *
 * Two halves, because the ordering a room is read in takes two columns to be
 * total and a cursor on an ordering that is not total is a bug waiting for two
 * messages to share an instant. `createdAt` alone is not total: two rows written
 * in the same instant tie, and the page boundary then falls between them in
 * whichever order the database happened to answer, so the same tie either
 * repeats a message on both pages or drops it from both.
 *
 * The identifier breaks it. It is not a time and says nothing about one - a cuid
 * is not ordered by when it was made - and it is not asked to be: all it has to
 * do is make exactly one row the boundary and answer the same way twice.
 *
 * The comment thread's cursor is the same two columns and is deliberately not
 * shared with this one. A cursor is the wire format of the endpoints that issue
 * it, and one parser behind two products' query strings would mean a change to
 * how a thread pages silently changed how a chat does. This one is also read in
 * both directions - {@link olderThan} for the page before, {@link newerThan} for
 * the poll - which the thread never asks for.
 */
export interface ChatCursor {
  /** The instant of the message the page ended at. */
  createdAt: Date;
  /** That message's identifier, which breaks a tie on the instant. */
  id: string;
}

/**
 * Separates the two halves of a cursor.
 *
 * A character neither half can contain: an ISO instant is digits and punctuation
 * fixed by the format, and an identifier is a cuid.
 */
const CURSOR_SEPARATOR = "|";

/** The cursor for the page ending at this message. */
export function chatCursor(row: { id: string; createdAt: Date }): string {
  return `${row.createdAt.toISOString()}${CURSOR_SEPARATOR}${row.id}`;
}

/**
 * The cursor a reader handed back, or null when it is not one.
 *
 * Null rather than a lenient reading, and the controller turns it into a
 * refusal. A cursor this service cannot make sense of names a place nobody can
 * name, and answering it with the newest page instead would answer a different
 * question: a reader pressing for the messages before the ones on their screen
 * would be handed the ones already there, and a poll would be answered with
 * messages it had shown an hour ago.
 *
 * Exported so the round trip can be asserted directly rather than only through
 * a read.
 */
export function parseChatCursor(value: string): ChatCursor | null {
  const halves = value.split(CURSOR_SEPARATOR);
  if (halves.length !== 2) {
    /*
     * Exactly two halves, so a value carrying a second separator is refused
     * rather than read as an identifier containing one. Neither half of a cursor
     * this application issued can hold the separator at all.
     */
    return null;
  }
  const [instant, id] = halves;
  /*
   * Neither half may be empty: a cursor names an instant and a message, and a
   * value with one of them missing names neither. The undefined the compiler
   * allows for an index is unreachable past the length check above.
   */
  if (
    instant === undefined ||
    id === undefined ||
    instant === "" ||
    id === ""
  ) {
    return null;
  }

  const createdAt = new Date(instant);
  /*
   * Round-tripped rather than merely parsed. `new Date` accepts more than one
   * spelling of a moment and reads some strings that are not one at all, so an
   * instant that does not come back out exactly as it went in is refused - a
   * cursor is compared against a stored column and has to mean one moment.
   */
  if (
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== instant
  ) {
    return null;
  }

  return { createdAt, id };
}

/**
 * Who wrote a message, as the room may say.
 *
 * Three cases, and the two that are not a plain name are the point of the type,
 * exactly as for `NewsCommentAuthorView`.
 *
 * `protected` is a person with protected personal data (skyddade
 * personuppgifter). Their name is withheld here even though the board's own
 * address book prints it, and withheld from every reader of the room although
 * every one of them holds `protectedData:reveal` with their seat. That
 * capability is what lets somebody perform an act of revealing and be recorded
 * doing it; a room where the name simply appeared, in a payload nothing audits,
 * on a screen left open, is not that act. The association's own record of
 * processing says people with protected personal data are masked everywhere, and
 * a new room that named them would make that record false.
 *
 * `unknown` is an author reference that no longer resolves to a person. A
 * message is service tier and a person can be purged out from under one, so the
 * room has to be able to say "we no longer know" rather than break.
 */
export type ChatAuthorView =
  | { kind: "person"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

/** One message, as a reader is shown it. */
export interface ChatMessageView {
  id: string;
  author: ChatAuthorView;
  /** What was written. Never withheld: nothing strikes a message through. */
  body: string;
  /** ISO instant it was written. */
  createdAt: string;
}

/** One room this person is in, as the list of rooms says it. */
export interface ChatRoomView {
  id: string;
  kind: ChatKind;
  /** A group's name, or null for the board chat, whose name is its kind. */
  name: string | null;
  /**
   * How many messages this person has not read.
   *
   * Their own are never counted: somebody who has just written a line does not
   * have an unread one. Everything counts while there is no read marker at all,
   * which is what a room somebody has never opened should say.
   */
  unread: number;
  /** ISO instant of the newest message, or null while the room is empty. */
  lastMessageAt: string | null;
}

/** One page of a room, and where the page before it starts. */
export interface ChatPage {
  /** The messages on this page, oldest first. */
  messages: ChatMessageView[];
  /**
   * The cursor for the page before this one, or null at the start of the room.
   *
   * Handed straight back as `before` to read it. Null is the whole of the answer
   * to "is there more", so a reader is never left inferring it from a page that
   * came back short.
   */
  earlier: string | null;
  /**
   * The cursor the poll continues from, or null while the room is empty.
   *
   * The newest message on this page, which on the first read is the newest
   * message in the room. A screen polls from here.
   */
  latest: string | null;
}

/** What has arrived since a cursor. */
export interface ChatUpdate {
  /** The messages written since, oldest first. */
  messages: ChatMessageView[];
  /**
   * Where to ask from next time.
   *
   * The cursor handed in comes straight back when nothing has arrived, so a
   * screen polling an idle room hands back the same value rather than losing its
   * place.
   */
  cursor: string;
  /**
   * Whether more was waiting than one page holds.
   *
   * A screen catching up after a week asks again immediately rather than waiting
   * out its interval, and does it a page at a time.
   */
  more: boolean;
}

export interface WriteChatMessageInput {
  chatId: string;
  authorPersonId: string;
  body: string;
}

const MESSAGE_COLUMNS = {
  id: true,
  chatId: true,
  authorPersonId: true,
  body: true,
  createdAt: true,
} as const;

/**
 * The chat (chatten): the rooms somebody is in, and what is said in them.
 *
 * Five rules live here and nowhere else.
 *
 * **Membership decides the room; the capability decides the endpoint.** The
 * global guard requires `chat:participate` on every route, and this service then
 * answers which rooms exist for the caller. Those are two questions and both
 * have to be answered: the administrator holds every capability and holds no
 * board seat, so they reach every route here and find no room. That is the same
 * division as `news:comment` gating the comment controller while the service
 * decides which threads there are.
 *
 * The board chat's membership is derived and never written down: whoever holds a
 * board seat that has not ended. A person joins it the day their term is
 * recorded and leaves it the day the term ends, without anybody administering a
 * list. The seat predicate is the whole security boundary here, which is why it
 * is `activeBoardSeatWhere` and not `activeBoardRecipientsWhere` - the recipient
 * list additionally requires an address, and a board member the association
 * holds no address for still sits on the board and must still read the room.
 *
 * **One refusal for two cases.** A room that does not exist and a room this
 * person is not in are the same answer. Distinguishing them would let anybody
 * holding the capability walk the identifier space and learn what rooms the
 * association has, and once there are groups it is what makes a group invisible
 * to somebody outside it.
 *
 * **Nothing is ever erased except by the retention clock.** No edit, no delete,
 * no withdraw, by the author or by anybody else - what somebody wrote is a
 * record of what was said. And no strike-through either, which is where the
 * board chat parts company with a comment thread: a thread under a notice is
 * part of what the association publishes and the board answers for it, while
 * the board chat publishes nothing and the board is the whole room. A board able
 * to strike a colleague's line would be deciding what the record of its own
 * deliberation says.
 *
 * **A personal identity number is refused.** Every message is scanned on the way
 * in and a hit refuses the write, naming the offset and never the value. The
 * board may read the apartment register, and that is exactly why the rule holds
 * here: a number pasted out of the register into a service-tier room is a second
 * copy of it that the register cannot account for and that the chat's own purge
 * erases on a different clock.
 *
 * **A message write is not audited, and the departure is deliberate.** A comment
 * writes `NEWS_COMMENT_POSTED` because a member's own words about a notice are
 * their data and their access report has to be able to say when they wrote them.
 * A chat message is on that report in full, carrying its author and its instant,
 * so the entry would restate what the row already says - and a board of eight at
 * thirty messages a day is about eleven thousand rows a year in a table the
 * database refuses to update or delete and every purge is forbidden to touch.
 * What is audited is the acts that change who can read a room, and in the board
 * chat there are none: nobody is put into the room or taken out of it, an
 * election is.
 *
 * ## No optimistic anything
 *
 * A message arrives on a screen because a read brought it, never because the
 * screen put it there. That is what makes the poll the one delivery path rather
 * than a second opinion about one, and it is the news thread's own rule.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every room this person is in, with what is unread in each.
   *
   * Empty for somebody with no board seat, which is the whole answer rather than
   * a refusal: they are in no room, and the screen says so.
   *
   * The board chat row is created here on first read if it is absent, so a fresh
   * instance needs no seed and nothing has to remember to create one when the
   * first board is recorded. Only a caller who holds a seat creates it - a room
   * brought into existence by somebody who cannot read it would be a row written
   * by an administrator looking at an empty screen.
   */
  async rooms(reader: Principal): Promise<ChatRoomView[]> {
    // Taken once, so a single request cannot see two different boards.
    const now = new Date();
    if (!(await this.holdsBoardSeat(reader.personId, now))) {
      return [];
    }

    const chat = await this.boardChat();
    return [await this.roomView(chat, reader.personId)];
  }

  /**
   * One page of a room, oldest first within the page.
   *
   * ## Which page, when nobody asks for one
   *
   * The newest, and then backwards. A page is cut from the end the room has
   * reached and turned round inside itself, so the order a message is read in
   * never changes while the reader still lands where the conversation is.
   * Cutting from the other end would open a year-old room at the oldest thing in
   * it and put today's exchange behind however many presses the room is long -
   * and it would hide a reader's own message the moment they wrote one, because
   * a message is written at the newest end.
   *
   * ## Why a cursor and not a page number
   *
   * A room is written into while it is being read, and an offset from the end
   * shifts by one for every message somebody adds - so page two by offset would
   * repeat what page one had shown, or step over it, entirely depending on how
   * busy the room was. A cursor names a place rather than a distance from an
   * end, so the page before this one is the same page however much has been
   * written since.
   */
  async readChat(
    chatId: string,
    reader: Principal,
    before: ChatCursor | null = null,
  ): Promise<ChatPage> {
    await this.requireMembership(chatId, reader);

    /*
     * One more row than the page holds, which is how "there is a page before
     * this one" is answered. A separate count would be a second statement about
     * a second moment, and could say there was more when the extra message had
     * been purged between the two - a page offered and then answered empty.
     */
    const rows = await this.prisma.chatMessage.findMany({
      where: { chatId, ...(before === null ? {} : olderThan(before)) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MESSAGES_PER_PAGE + 1,
      select: MESSAGE_COLUMNS,
    });

    const page = rows.slice(0, MESSAGES_PER_PAGE);
    const oldest = page.at(-1);
    /*
     * The cursor is the oldest message kept rather than the extra row read, so
     * the next page starts exactly where this one stopped. `oldest` is only
     * undefined on an empty page, which cannot also have read a row past it.
     */
    const earlier =
      oldest !== undefined && rows.length > page.length
        ? chatCursor(oldest)
        : null;
    const newest = page.at(0);

    return {
      // A reversed copy, so the rows the cursors were taken from are not
      // reordered under the two lines above by the time anybody reads them.
      messages: await this.toViews([...page].reverse()),
      earlier,
      /*
       * Where the poll starts. Null on an empty page, and on an empty page that
       * came from a `before` cursor the caller already holds a newer one - which
       * is why the screen only ever takes this from its first read.
       */
      latest: newest === undefined ? null : chatCursor(newest),
    };
  }

  /**
   * What has been written since a cursor, oldest first.
   *
   * The mirror of {@link readChat}, and the only delivery path there is. It is
   * bounded for the reason the page is: a screen that was closed for a week asks
   * for a week of messages, and an unbounded read of that is an outage rather
   * than a slow response. It answers with a page, a cursor and whether more is
   * waiting, so catching up is several reads and each one is small.
   */
  async messagesSince(
    chatId: string,
    reader: Principal,
    cursor: ChatCursor,
  ): Promise<ChatUpdate> {
    await this.requireMembership(chatId, reader);

    const rows = await this.prisma.chatMessage.findMany({
      where: { chatId, ...newerThan(cursor) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MESSAGES_PER_PAGE + 1,
      select: MESSAGE_COLUMNS,
    });

    const page = rows.slice(0, MESSAGES_PER_PAGE);
    const newest = page.at(-1);

    return {
      messages: await this.toViews(page),
      // The cursor handed in comes back when nothing arrived, so a screen
      // polling an idle room keeps its place rather than restarting from the
      // beginning of the room.
      cursor: newest === undefined ? chatCursor(cursor) : chatCursor(newest),
      more: rows.length > page.length,
    };
  }

  /**
   * Writes a message.
   *
   * The three refusals in order: a room this person is not in, a person who has
   * written too many, and text carrying a personal identity number. The first is
   * first because it is the cheapest and the least revealing - a caller learns
   * only what they would learn by asking to read the room.
   *
   * One statement and no transaction, which is worth saying rather than leaving
   * to be noticed. A comment's write is a transaction because it writes the
   * audit entry with the row; this one has no entry to write, for the reason the
   * class comment gives, so a transaction would wrap a single insert and promise
   * nothing.
   */
  async write(input: WriteChatMessageInput): Promise<ChatMessageView> {
    const chat = await this.requireMembershipById(
      input.chatId,
      input.authorPersonId,
    );
    await this.refuseTooManyMessages(input.authorPersonId);
    refusePersonalIdentityNumbers(input.body);

    const row = await this.prisma.chatMessage.create({
      data: {
        chatId: chat.id,
        authorPersonId: input.authorPersonId,
        body: input.body,
      },
      select: MESSAGE_COLUMNS,
    });

    // The room and nothing that was said in it - ADR 0007 keeps the identifier
    // and the log keeps no prose.
    this.logger.log(`A message was written in chat ${chat.id}`);

    return toView(row, await this.authorOf(row.authorPersonId));
  }

  /**
   * Records how far this person has read a room.
   *
   * Never backwards. Two tabs open on one room would otherwise un-read each
   * other, and a marker that moved back would announce messages the person had
   * already read. The insert and the comparison are one statement, so two tabs
   * racing each other settle rather than overwrite: the later instant wins
   * whichever arrives second.
   *
   * Written in SQL because Prisma's upsert has no conditional update - its
   * `update` clause runs whatever the stored row holds, which is exactly the
   * backwards move this refuses.
   *
   * Capped at this server's own clock, which is what stops the forward-only
   * rule being turned into a weapon. The instant arrives from the caller, and a
   * single call carrying one far in the future - a device whose clock is wrong,
   * or a request somebody composed - would set a marker no later call could
   * lower. From then on every message counts as read for that person, including
   * ones written afterwards, and there is no way back: nothing moves a marker
   * backwards, which is the whole point of the row. A marker can only ever say
   * that somebody has read as far as something that already exists.
   *
   * @param readAt The instant to mark, which is the newest message the screen
   *   has actually shown rather than the moment of the request: a room read at
   *   the moment a message was in flight must not mark that message read.
   */
  async markRead(
    chatId: string,
    reader: Principal,
    readAt: Date,
  ): Promise<{ readAt: string }> {
    await this.requireMembership(chatId, reader);

    // Taken once, so the cap and the value written cannot come from two moments.
    const now = new Date();
    const marked = readAt.getTime() > now.getTime() ? now : readAt;

    await this.prisma.$executeRaw`
      INSERT INTO "chat_read" ("chatId", "personId", "readAt")
      VALUES (${chatId}, ${reader.personId}, ${marked})
      ON CONFLICT ("chatId", "personId")
      DO UPDATE SET "readAt" = GREATEST("chat_read"."readAt", EXCLUDED."readAt")
    `;

    const marker = await this.prisma.chatRead.findUnique({
      where: { chatId_personId: { chatId, personId: reader.personId } },
      select: { readAt: true },
    });

    /*
     * Read back rather than echoed, so a screen whose instant lost the
     * comparison is told the marker that actually stands. The row cannot be
     * absent: the statement above either inserted it or found it.
     */
    return { readAt: (marker?.readAt ?? marked).toISOString() };
  }

  /**
   * The board's chat, created if this instance has never had one.
   *
   * A partial unique index makes exactly one row of kind BOARD possible, so two
   * requests arriving at a fresh instance together settle rather than each
   * creating a room: one insert wins and the other is answered by the read that
   * follows it. `create` is not upsert because there is nothing to update, and
   * the conflict is expected rather than exceptional.
   */
  private async boardChat(): Promise<{
    id: string;
    kind: ChatKind;
    name: string | null;
  }> {
    const existing = await this.prisma.chat.findFirst({
      where: { kind: "BOARD" },
      select: { id: true, kind: true, name: true },
    });
    if (existing !== null) {
      return existing;
    }

    try {
      return await this.prisma.chat.create({
        data: { kind: "BOARD" },
        select: { id: true, kind: true, name: true },
      });
    } catch {
      /*
       * Somebody else created it between the read and the insert, which the
       * index made impossible to do twice. Reading again is the whole of the
       * recovery, and the row is there because the statement that refused this
       * one had committed it.
       */
      const created = await this.prisma.chat.findFirst({
        where: { kind: "BOARD" },
        select: { id: true, kind: true, name: true },
      });
      if (created === null) {
        throw new Error("The board chat could not be created or read.");
      }
      return created;
    }
  }

  /** One room with its unread count and the instant it was last written in. */
  private async roomView(
    chat: { id: string; kind: ChatKind; name: string | null },
    personId: string,
  ): Promise<ChatRoomView> {
    const marker = await this.prisma.chatRead.findUnique({
      where: { chatId_personId: { chatId: chat.id, personId } },
      select: { readAt: true },
    });
    const newest = await this.prisma.chatMessage.findFirst({
      where: { chatId: chat.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { createdAt: true },
    });
    const unread = await this.prisma.chatMessage.count({
      where: {
        chatId: chat.id,
        // Somebody who has just written a line does not have an unread one.
        authorPersonId: { not: personId },
        ...(marker === null ? {} : { createdAt: { gt: marker.readAt } }),
      },
    });

    return {
      id: chat.id,
      kind: chat.kind,
      name: chat.name,
      unread,
      lastMessageAt: newest?.createdAt.toISOString() ?? null,
    };
  }

  /**
   * The room this person may read, or the one refusal.
   *
   * Every path takes it, and it is where the security boundary is. A room of
   * kind GROUP is refused here exactly as a room that does not exist: the value
   * is in the enum so that adding groups is not a migration over live rows, and
   * until a service answers it there are no groups to be in.
   */
  private async requireMembershipById(
    chatId: string,
    personId: string,
  ): Promise<{ id: string; kind: ChatKind; name: string | null }> {
    // Taken once for the whole call, so one request cannot see two boards.
    const now = new Date();
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { id: true, kind: true, name: true },
    });

    if (
      chat === null ||
      chat.kind !== "BOARD" ||
      !(await this.holdsBoardSeat(personId, now))
    ) {
      throw new ChatError("There is no such chat.", "chat-not-found");
    }

    return chat;
  }

  /** The same question, asked with a principal the routes already hold. */
  private async requireMembership(
    chatId: string,
    reader: Principal,
  ): Promise<{ id: string; kind: ChatKind; name: string | null }> {
    return this.requireMembershipById(chatId, reader.personId);
  }

  /**
   * Whether this person holds a board seat that has not ended.
   *
   * Asked of the register on every call rather than read off the principal's
   * `isBoardMember`. The principal is derived from the same query and would be
   * the same answer today, but this is the membership of a room rather than a
   * role for a screen, and a room that trusted a flag computed somewhere else
   * would be a boundary that moved the day that flag was cached.
   */
  private async holdsBoardSeat(personId: string, now: Date): Promise<boolean> {
    const person = await this.prisma.person.findFirst({
      where: { id: personId, ...activeBoardSeatWhere(now) },
      select: { id: true },
    });
    return person !== null;
  }

  /** Refuses a person who has written their allowance for the window. */
  private async refuseTooManyMessages(authorPersonId: string): Promise<void> {
    const since = new Date(Date.now() - WRITE_WINDOW_MINUTES * 60 * 1000);
    const written = await this.prisma.chatMessage.count({
      where: { authorPersonId, createdAt: { gte: since } },
    });
    if (written >= MESSAGES_PER_WRITE_WINDOW) {
      throw new ChatError(
        "Too many messages in too short a time. Try again shortly.",
        "too-many-messages",
      );
    }
  }

  /** Every view in a page, with the authors resolved in one read. */
  private async toViews(
    rows: readonly MessageRow[],
  ): Promise<ChatMessageView[]> {
    const authorIds = [...new Set(rows.map((row) => row.authorPersonId))];
    const persons =
      authorIds.length === 0
        ? []
        : await this.prisma.person.findMany({
            where: { id: { in: authorIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              protectedPersonalData: true,
            },
          });
    const byId = new Map(persons.map((person) => [person.id, person]));

    return rows.map((row) =>
      toView(
        row,
        authorViewOf(row.authorPersonId, byId.get(row.authorPersonId)),
      ),
    );
  }

  /** One author, read on its own, for the single-message paths. */
  private async authorOf(personId: string): Promise<ChatAuthorView> {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        protectedPersonalData: true,
      },
    });
    return authorViewOf(personId, person ?? undefined);
  }
}

interface MessageRow {
  id: string;
  chatId: string;
  authorPersonId: string;
  body: string;
  createdAt: Date;
}

/**
 * Everything in a room strictly before one point in it.
 *
 * The comparison the ordering implies, written out rather than handed to the
 * query builder's own cursor option. That one names a row: it reads the boundary
 * values back out of the message the cursor points at, and a message can be
 * purged out from under a reader between one page and the next, because a room
 * is erased on its own clock a year at a time. A cursor whose row has gone
 * matches nothing at all - a page silently empty, which is the failure paging
 * exists to remove rather than to introduce somewhere new. These comparisons are
 * against the two values the reader was handed, so the row they were read from
 * no longer has to be there.
 *
 * The index on `(chatId, createdAt)` answers the first branch. The second only
 * ever sorts rows sharing one instant, which is a handful at most.
 */
function olderThan(cursor: ChatCursor) {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

/**
 * Everything in a room strictly after one point in it.
 *
 * The mirror of {@link olderThan}, and the whole of what a poll asks. It
 * survives a purged row for the same reason: the comparisons are against the two
 * values the reader was handed and not against a row that still has to be there.
 * That matters more here than on the page, because a screen left open overnight
 * polls with a cursor whose message the purge may have reached.
 */
function newerThan(cursor: ChatCursor) {
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ],
  };
}

/** One message as a reader is shown it. */
function toView(row: MessageRow, author: ChatAuthorView): ChatMessageView {
  return {
    id: row.id,
    author,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Who a message is attributed to, from the person the register still holds.
 *
 * A person with protected personal data is named to nobody, and a reference that
 * no longer resolves is reported as unknown rather than as an empty name: a
 * message outlives nothing, but the person who wrote it can be erased while the
 * room still holds their words.
 */
function authorViewOf(
  personId: string,
  person:
    | {
        id: string;
        firstName: string;
        lastName: string;
        protectedPersonalData: boolean;
      }
    | undefined,
): ChatAuthorView {
  if (person === undefined) {
    return { kind: "unknown" };
  }
  if (person.protectedPersonalData) {
    return { kind: "protected", personId };
  }
  return {
    kind: "person",
    personId,
    name: `${person.firstName} ${person.lastName}`.trim(),
  };
}

/**
 * Refuses a message carrying a Swedish personal identity number.
 *
 * The same rule a page, a news item and a comment live under. The board may read
 * the apartment register, and DESIGN.md forbids a personal identity number
 * outside the register views for exactly that reason: a number copied out of the
 * register into a service-tier room is a second copy the register cannot account
 * for, held on a different clock, in a room the register's own rules do not
 * reach.
 *
 * Exported so the rule can be asserted directly rather than only through a
 * write.
 */
export function refusePersonalIdentityNumbers(body: string): void {
  const locations = scanForPersonalIdentityNumbers(body).map(
    (hit): ChatTextLocation => ({ part: "body", offset: hit.index }),
  );

  if (locations.length > 0) {
    throw new ChatError(
      "The message carries a personal identity number and cannot be written.",
      "personal-identity-number",
      locations,
    );
  }
}
