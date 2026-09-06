import { apiRequest, type ApiResult } from "./client";

/**
 * The board's shared mailbox.
 *
 * These types mirror the API's wire shapes rather than importing them: the
 * browser and the server are separate builds, and a shared declaration would
 * make the client's compilation depend on the server's source tree.
 *
 * Two properties of the contract are load-bearing and invisible in the types.
 *
 * A message body is always text and never markup. The server converts an HTML
 * part as it collects it and keeps no markup at all, so a screen renders a body
 * as text - which is why nothing here has ever needed a sanitiser and why adding
 * one would be a sign that something upstream had changed.
 *
 * A correspondent is an address an envelope asserted, not a person. Nothing in
 * this module resolves one to somebody in the register, and a screen must not
 * present one as though it had: what the board is looking at is a letter signed
 * with a name, which is exactly as much as anybody knows.
 */

export type BoardMailboxThreadStatus = "NEW" | "TAKEN" | "ANSWERED" | "CLOSED";

export const BOARD_MAILBOX_STATUSES: readonly BoardMailboxThreadStatus[] = [
  "NEW",
  "TAKEN",
  "ANSWERED",
  "CLOSED",
];

/** A board member named on a thread, in the three shapes the server answers with. */
export type BoardMailboxMember =
  | { kind: "member"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

export interface BoardMailboxCorrespondent {
  email: string;
  /** What the sender called themselves, when they said. Never an identity. */
  name: string | null;
}

export interface BoardMailboxAttachment {
  id: string;
  /** A path on this instance's own origin, never an address at a bucket. */
  url: string;
  fileName: string;
  byteSize: number;
  contentType: string;
}

export interface BoardMailboxMessage {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  /** Text, always. */
  body: string;
  bodyFromHtml: boolean;
  bodyTruncated: boolean;
  attachmentsDropped: number;
  occurredAt: string;
  sentBy: BoardMailboxMember | null;
  delivery: {
    status: "PENDING" | "SENT" | "FAILED";
    /** A failure code, never the mail server's own words. */
    failure: string | null;
    sentAt: string | null;
  } | null;
  attachments: BoardMailboxAttachment[];
}

export interface BoardMailboxThreadSummary {
  id: string;
  subject: string;
  correspondent: BoardMailboxCorrespondent;
  status: BoardMailboxThreadStatus;
  takenBy: BoardMailboxMember | null;
  lastMessageAt: string;
  messageCount: number;
  erasableFrom: string;
}

export interface BoardMailboxThread extends BoardMailboxThreadSummary {
  messages: BoardMailboxMessage[];
  /** What to ask for to read the page before this one. Null at the beginning. */
  olderCursor: string | null;
}

/** The inbox, and how to read past it. */
export interface BoardMailboxThreadList {
  threads: BoardMailboxThreadSummary[];
  /** Whether the mailbox holds threads this page does not list. */
  more: boolean;
  /** What to ask for to read the next page. Null on the last of them. */
  nextCursor: string | null;
}

export interface BoardMailboxStatus {
  configured: boolean;
  address: string | null;
}

/** What one collection did. Counts only: no address and no subject. */
export interface BoardMailboxCollection {
  configured: boolean;
  available: number;
  collected: number;
  alreadyHeld: number;
  skipped: number;
}

export function fetchBoardMailboxStatus(): Promise<
  ApiResult<BoardMailboxStatus>
> {
  return apiRequest("GET", "/api/board-mailbox/status");
}

export function fetchBoardMailboxThreads(
  after?: string,
): Promise<ApiResult<BoardMailboxThreadList>> {
  const query =
    after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
  return apiRequest("GET", `/api/board-mailbox/threads${query}`);
}

export function fetchBoardMailboxThread(
  threadId: string,
  before?: string,
): Promise<ApiResult<BoardMailboxThread>> {
  const query =
    before === undefined ? "" : `?before=${encodeURIComponent(before)}`;
  return apiRequest(
    "GET",
    `/api/board-mailbox/threads/${encodeURIComponent(threadId)}${query}`,
  );
}

export function takeBoardMailboxThread(input: {
  threadId: string;
}): Promise<ApiResult<BoardMailboxThread>> {
  return apiRequest(
    "POST",
    `/api/board-mailbox/threads/${encodeURIComponent(input.threadId)}/take`,
  );
}

export function releaseBoardMailboxThread(input: {
  threadId: string;
}): Promise<ApiResult<BoardMailboxThread>> {
  return apiRequest(
    "POST",
    `/api/board-mailbox/threads/${encodeURIComponent(input.threadId)}/release`,
  );
}

export function replyToBoardMailboxThread(input: {
  threadId: string;
  body: string;
}): Promise<ApiResult<BoardMailboxThread>> {
  return apiRequest(
    "POST",
    `/api/board-mailbox/threads/${encodeURIComponent(input.threadId)}/reply`,
    { body: input.body },
  );
}

export function setBoardMailboxThreadClosed(input: {
  threadId: string;
  closed: boolean;
}): Promise<ApiResult<BoardMailboxThread>> {
  return apiRequest(
    "POST",
    `/api/board-mailbox/threads/${encodeURIComponent(input.threadId)}/closed`,
    { closed: input.closed },
  );
}

/** Collects the mailbox now, and answers what arrived. */
export function collectBoardMailbox(): Promise<
  ApiResult<BoardMailboxCollection>
> {
  return apiRequest("POST", "/api/board-mailbox/collect");
}
