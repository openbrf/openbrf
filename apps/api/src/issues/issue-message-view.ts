import type { IssueSignature } from "@openbrf/shared";

import type { Prisma } from "../generated/prisma/client";

/**
 * An issue message as the issue's reporter reads it (decisions 18 and 19), in
 * a module of its own so that every reader of a reporter's conversation builds
 * it the one way: the reporter's own screen, the private link's page and the
 * data subject access report (`ReportIssue.messages`).
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

/** Oldest first, with the identifier to order two written at one instant. */
export const ISSUE_MESSAGE_ORDER = [
  { createdAt: "asc" },
  { id: "asc" },
] as const satisfies Prisma.IssueMessageOrderByWithRelationInput[];

export const ISSUE_MESSAGE_SELECT = {
  id: true,
  side: true,
  authorPersonId: true,
  signature: true,
  body: true,
  redactedAt: true,
  createdAt: true,
} as const;

export type IssueMessageRecord = Prisma.IssueMessageGetPayload<{
  select: typeof ISSUE_MESSAGE_SELECT;
}>;

/**
 * A message as its reporter reads it: the writer's role on a handler's, and
 * no person on either. Built from the columns alone, so there is no person on
 * the row to leak.
 */
export function toReporterView(
  message: IssueMessageRecord,
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
