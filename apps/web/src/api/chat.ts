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
 * the two are separate questions. The administrator holds every capability and
 * no board seat, so they reach every route here and are answered with no rooms
 * at all. That is not a failure and the screen must not render it as one.
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
 * There is no hidden state and no edited state. A message is written once and
 * never edited, never deleted and never withdrawn, by its author or by anybody
 * else - what somebody wrote is a record of what was said, and the only thing
 * that removes one is the retention clock. The board chat has no strike-through
 * either: the board is the whole room, and a board able to strike a colleague's
 * line would be deciding what the record of its own deliberation says.
 */
export interface ChatMessage {
  id: string;
  author: ChatAuthor;
  body: string;
  /** ISO instant it was written. */
  createdAt: string;
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
 * The rooms this account is in.
 *
 * An empty list is the answer for somebody holding the capability and no board
 * seat, and the screen says so in words rather than rendering an empty room.
 */
export function fetchChats(): Promise<ApiResult<ChatRoom[]>> {
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
