import { apiRequest, type ApiResult } from "./client";

/**
 * The chat, as the application reads and writes it.
 *
 * These types mirror the API's wire shapes rather than importing them: the
 * browser and the server are separate builds, and a shared declaration would
 * make the client's compilation depend on the server's source tree.
 *
 * Four properties of the contract are load-bearing and none of them is visible
 * in the types, so they are written down here.
 *
 * **Which rooms exist is the server's answer, and an empty list is an answer.**
 * The capability opens these endpoints; membership decides what is in them, and
 * the two are separate questions. The administrator holds every capability, no
 * board seat and no residency, so they reach every route here and are answered
 * with no rooms and no way to make one. That is not a failure and the screen
 * must not render it as one.
 *
 * **A group is invisible from outside, and this client must not undo that.**
 * There is no call here that lists groups and none that reads one this account
 * is not in: a room it is not in is refused exactly as a room that does not
 * exist. The board reaches a group only through a message somebody inside it
 * reported, which is `fetchChatReports` and carries one message each time -
 * never a room.
 *
 * **Nothing is ever appended by the browser.** A message reaches a screen
 * because a read brought it, which is what makes the poll the one delivery path
 * rather than a second opinion about one. The answer to a write is one message
 * and the room is the whole of it, so a list assembled from both is a list
 * nothing on the server ever said.
 *
 * **A cursor goes back exactly as it arrived.** What one holds is the API's
 * business, and a value this client composed for itself is answered with a
 * refusal rather than a page.
 *
 * **Nothing here is ever published.** The association's website reads no session
 * at all, so there is no audience for a room; there is no route that renders one
 * publicly and there is not going to be one.
 */

/** Which kind of room, which is what decides who is in it. */
export type ChatKind = "BOARD" | "GROUP";

/**
 * Who wrote a message, as the room may say.
 *
 * `protected` is a person with protected personal data (skyddade
 * personuppgifter). Their name is withheld from every reader of the room,
 * although each of them holds `protectedData:reveal` with their seat: that
 * capability is what lets somebody perform an act of revealing and be recorded
 * doing it, and a name that simply appeared in a payload nothing audits is not
 * that act.
 *
 * `unknown` is an author reference that no longer resolves to a person. A
 * message is erased on its own clock and a person can be purged out from under
 * one, so a room has to be able to say "we no longer know" rather than break.
 */
export type ChatAuthor =
  | { kind: "person"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

/**
 * One message, as this reader is shown it.
 *
 * There is no edited state. A message is written once and never edited, never
 * deleted and never withdrawn, by its author or by anybody else - what somebody
 * wrote is a record of what was said, and the only thing that removes one is the
 * retention clock.
 *
 * One thing can happen to it afterwards and it happens in a group alone: the
 * board strikes it through after somebody in the room reported it. `body` is
 * then null for everybody but its author and the board, and the message stays on
 * the screen with its author's name on it. Whether the text is withheld is the
 * server's answer per reader and never this client's decision. The board chat
 * has no strike-through at all: the board is the whole room, and a board able to
 * strike a colleague's line would be deciding what the record of its own
 * deliberation says.
 */
export interface ChatMessage {
  id: string;
  author: ChatAuthor;
  /** What was written, or null when it was struck and withheld from us. */
  body: string | null;
  /** ISO instant the board struck it through, or null while it stands. */
  struckAt: string | null;
  /** ISO instant it was written. */
  createdAt: string;
}

/** The rooms this account is in, and whether it may make one. */
export interface ChatRoomList {
  rooms: ChatRoom[];
  /**
   * Whether this account may create a group.
   *
   * Living here is the whole of the condition, and no capability says whether
   * somebody lives here - so it is the server's answer rather than something
   * this client works out from the viewer.
   */
  mayCreateGroup: boolean;
}

/** One room this person is in, as the list of rooms says it. */
export interface ChatRoom {
  id: string;
  kind: ChatKind;
  /** A group's name, or null for the board chat, whose name is its kind. */
  name: string | null;
  /** How many messages this person has not read. Never their own. */
  unread: number;
  /** ISO instant of the newest message, or null while the room is empty. */
  lastMessageAt: string | null;
}

/**
 * One page of a room, and where the pages either side of it start.
 *
 * `earlier` is the whole of the answer to "is there more behind this": the
 * cursor to hand back for the page before this one, or null at the start of the
 * room. So a screen never infers it from a page that came back full.
 *
 * `latest` is where the poll starts. Null while the room is empty.
 */
export interface ChatPage {
  /** The messages on this page, oldest first. */
  messages: ChatMessage[];
  earlier: string | null;
  latest: string | null;
}

/** What has arrived since a cursor. */
export interface ChatUpdate {
  /** The messages written since, oldest first. */
  messages: ChatMessage[];
  /**
   * Where to ask from next time.
   *
   * The cursor handed in comes straight back when nothing has arrived, so a
   * screen polling an idle room keeps its place rather than losing it.
   */
  cursor: string;
  /**
   * Whether more was waiting than one page holds.
   *
   * A screen catching up after a week asks again at once rather than waiting out
   * its interval, and does it a page at a time.
   */
  more: boolean;
}

/**
 * The rooms this account is in, and whether it may make one.
 *
 * An empty list is the answer for somebody holding the capability and no room,
 * and the screen says so in words rather than rendering an empty room. The two
 * empty cases are different sentences - somebody who lives here has a form in
 * front of them and the administrator has none - which is why the answer carries
 * the second half.
 */
export function fetchChats(): Promise<ApiResult<ChatRoomList>> {
  return apiRequest("GET", "/api/chat");
}

/**
 * One page of a room, oldest first inside the page.
 *
 * `before` is a cursor this API handed out, or null for the newest page.
 */
export function readChat(input: {
  chatId: string;
  before: string | null;
}): Promise<ApiResult<ChatPage>> {
  const page =
    input.before === null ? "" : `?before=${encodeURIComponent(input.before)}`;
  return apiRequest(
    "GET",
    `/api/chat/${encodeURIComponent(input.chatId)}${page}`,
  );
}

/** What has been written in a room since a cursor. The one delivery path. */
export function messagesSince(input: {
  chatId: string;
  after: string;
}): Promise<ApiResult<ChatUpdate>> {
  return apiRequest(
    "GET",
    `/api/chat/${encodeURIComponent(input.chatId)}/since?after=${encodeURIComponent(
      input.after,
    )}`,
  );
}

export function writeMessage(input: {
  chatId: string;
  body: string;
}): Promise<ApiResult<ChatMessage>> {
  return apiRequest("POST", `/api/chat/${encodeURIComponent(input.chatId)}`, {
    body: input.body,
  });
}

/**
 * Records how far this person has read a room.
 *
 * `readAt` is the instant of the newest message actually on screen rather than
 * the moment of the call: a room marked read at "now" would mark a message read
 * that was written while the request was in flight and that nobody has seen.
 * The marker never moves backwards, so two tabs cannot un-read each other.
 */
export function markChatRead(input: {
  chatId: string;
  readAt: string;
}): Promise<ApiResult<{ readAt: string }>> {
  return apiRequest(
    "POST",
    `/api/chat/${encodeURIComponent(input.chatId)}/read`,
    { readAt: input.readAt },
  );
}

/** One person in a group, as the room's own panel says it. */
export interface ChatGroupMember {
  /**
   * Who they are, on exactly the terms a message's author is named.
   *
   * A person with protected personal data is not named here either: the room is
   * not the act of revealing that `protectedData:reveal` exists for.
   */
  person: ChatAuthor;
  /** ISO instant they were put into the room. */
  joinedAt: string;
  /** Whether they made the room. A fact about it, and not an office. */
  createdTheGroup: boolean;
}

/** Somebody this room could still be offered, as the picker lists them. */
export interface ChatGroupCandidate {
  personId: string;
  name: string;
  /** Their apartment, so two neighbours with one name can be told apart. */
  apartment: string | null;
}

/** The board's queue of reported messages, and who may answer it. */
export interface ChatReportQueue {
  reports: ChatReport[];
  /** Whether this account holds a board seat as well as the capability. */
  mayModerate: boolean;
}

/**
 * One reported message, as the board is shown it.
 *
 * The whole of what a report carries: one message, who wrote it, who reported
 * it and what they said about it, and which room it came out of. There is no
 * call that takes this any further - no other message in that room, no member
 * list, and no way to open the room itself.
 */
export interface ChatReport {
  reportId: string;
  /** ISO instant the report was made. */
  reportedAt: string;
  reporter: ChatAuthor;
  /** What the reporter wanted to say about it, or null. */
  note: string | null;
  groupName: string | null;
  groupCreatedBy: ChatAuthor;
  messageId: string;
  author: ChatAuthor;
  /** What was written, in full: the board is deciding about this text. */
  body: string;
  writtenAt: string;
  /** ISO instant the board struck it through, or null while it stands. */
  struckAt: string | null;
}

/**
 * Makes a group, with this account as its first member.
 *
 * A name and nothing else. Who is in it is a second act with a record of its
 * own, because putting somebody into a private room is the thing the audit log
 * here exists for.
 */
export function createChatGroup(input: {
  name: string;
}): Promise<ApiResult<{ chatId: string; name: string }>> {
  return apiRequest("POST", "/api/chat-groups", { name: input.name });
}

/** Who is in a group, for somebody who is in it. */
export function fetchGroupMembers(input: {
  chatId: string;
}): Promise<ApiResult<ChatGroupMember[]>> {
  return apiRequest(
    "GET",
    `/api/chat-groups/${encodeURIComponent(input.chatId)}/members`,
  );
}

/**
 * Who this room could still be offered.
 *
 * People who live here and are not in it, never somebody with protected
 * personal data, bounded and searched by name.
 */
export function fetchGroupCandidates(input: {
  chatId: string;
  search: string;
}): Promise<ApiResult<ChatGroupCandidate[]>> {
  const search =
    input.search.trim() === ""
      ? ""
      : `?search=${encodeURIComponent(input.search.trim())}`;
  return apiRequest(
    "GET",
    `/api/chat-groups/${encodeURIComponent(input.chatId)}/candidates${search}`,
  );
}

/**
 * Puts somebody into a group, and answers with who is in it afterwards.
 *
 * Anybody in the room may do it. There is no counterpart that takes somebody
 * else out: what ends a place in a room against somebody's will is moving out.
 */
export function addGroupMember(input: {
  chatId: string;
  personId: string;
}): Promise<ApiResult<ChatGroupMember[]>> {
  return apiRequest(
    "POST",
    `/api/chat-groups/${encodeURIComponent(input.chatId)}/members`,
    { personId: input.personId },
  );
}

/**
 * Leaves a group.
 *
 * Only ever this account. What was written stays in the room, attributed exactly
 * as before and on the clock it was always on.
 */
export function leaveGroup(input: {
  chatId: string;
}): Promise<ApiResult<undefined>> {
  return apiRequest(
    "DELETE",
    `/api/chat-groups/${encodeURIComponent(input.chatId)}/members/me`,
  );
}

/**
 * Reports one message in a group to the board.
 *
 * The only thing that carries anything out of a group. It hands the board this
 * message and nothing else - not the room, not its members, not what was said
 * before it.
 */
export function reportChatMessage(input: {
  messageId: string;
  note: string;
}): Promise<ApiResult<{ reportId: string }>> {
  return apiRequest("POST", "/api/chat-reports", {
    messageId: input.messageId,
    ...(input.note.trim() === "" ? {} : { note: input.note.trim() }),
  });
}

/**
 * The board's queue, and whether this account may answer it.
 *
 * Holding `chat:moderate` is not the whole of it: the administrator holds every
 * capability and no board seat, and a report carries a private room's message in
 * full. So the server answers `mayModerate` from the register, and a screen
 * shown `false` says that the queue is the board's rather than that nothing has
 * been reported - which would be a claim about rooms this account may not be
 * told exist.
 */
export function fetchChatReports(): Promise<ApiResult<ChatReportQueue>> {
  return apiRequest("GET", "/api/chat-reports");
}

/**
 * Strikes the reported message through.
 *
 * Every open report about that message is closed with it, and so it is when one
 * is dismissed: the board decides about the message rather than about one
 * person's report of it.
 *
 * The text is withheld from the other people in the room and from nobody else:
 * the message stays where it is, attributed as before, its author still reads
 * it, and nothing about the retention clock changes. There is deliberately no
 * counterpart that clears it.
 */
export function strikeChatReport(input: {
  reportId: string;
}): Promise<ApiResult<ChatReport>> {
  return apiRequest(
    "POST",
    `/api/chat-reports/${encodeURIComponent(input.reportId)}/strike`,
  );
}

/** Closes a report without striking anything. */
export function dismissChatReport(input: {
  reportId: string;
}): Promise<ApiResult<ChatReport>> {
  return apiRequest(
    "POST",
    `/api/chat-reports/${encodeURIComponent(input.reportId)}/dismiss`,
  );
}
