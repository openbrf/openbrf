import type { IssueSignature } from "@openbrf/shared";

import type { Prisma } from "../generated/prisma/client";
import type { PrismaService } from "../database/prisma.service";

/**
 * The known fault (känt fel, decision 22): a short notice a handler writes
 * about an issue for the house, and the one rule for where it is shown.
 *
 * Read by the issues module for the report form and the resident's own page,
 * and by the feed for the post the issue was reported from, both through
 * `knownFaultShownWhere`, so the two cannot disagree about which notices
 * stand. Never read by the site layer: a known fault is for signed-in
 * residents and never on the public website.
 */

/**
 * A known fault (känt fel, decision 22) as the house reads it: the handler's
 * notice, the role it is signed with and when it was published, and the
 * issue's type, which is the board's own name for what kind of fault it is.
 * Nothing the reporter wrote, and nothing that says who reported it.
 */
export interface KnownFaultView {
  body: string;
  signature: IssueSignature;
  publishedAt: string;
  typeName: string;
}

/**
 * The issues whose known fault the house is shown (decision 22): open, with a
 * notice, and read by every handler, so neither an issue the board keeps to
 * itself nor one of a type it keeps to itself reaches anybody else through
 * one. Asked on every read rather than when the notice is written, so a notice
 * stops showing the moment the board takes its issue to itself.
 */
export function knownFaultShownWhere(): Prisma.IssueWhereInput {
  return {
    knownFault: { not: null },
    closedAt: null,
    status: { meaning: { not: "DONE" } },
    boardOnly: false,
    type: { handledBy: "EVERY_HANDLER" },
  };
}

/** The columns a known fault is read with. */
export const KNOWN_FAULT_SELECT = {
  knownFault: true,
  knownFaultSignature: true,
  knownFaultPublishedAt: true,
  type: { select: { name: true } },
} as const;

/** A known fault's notice, or null when the issue carries none. */
export function knownFaultOf(issue: {
  knownFault: string | null;
  knownFaultSignature: IssueSignature | null;
  knownFaultPublishedAt: Date | null;
}): Omit<KnownFaultView, "typeName"> | null {
  if (
    issue.knownFault === null ||
    issue.knownFaultSignature === null ||
    issue.knownFaultPublishedAt === null
  ) {
    return null;
  }
  return {
    body: issue.knownFault,
    signature: issue.knownFaultSignature,
    publishedAt: issue.knownFaultPublishedAt.toISOString(),
  };
}

/**
 * The known faults shown on these issues, by issue, for the feed's posts: one
 * query for a page, by the same rule as the report form's.
 */
export async function readKnownFaults(
  db: Prisma.TransactionClient | PrismaService,
  issueIds: readonly string[],
): Promise<Map<string, Omit<KnownFaultView, "typeName">>> {
  if (issueIds.length === 0) {
    return new Map();
  }
  const issues = await db.issue.findMany({
    where: { id: { in: [...new Set(issueIds)] }, ...knownFaultShownWhere() },
    select: { id: true, ...KNOWN_FAULT_SELECT },
  });
  const shown = new Map<string, Omit<KnownFaultView, "typeName">>();
  for (const issue of issues) {
    const view = knownFaultOf(issue);
    if (view !== null) {
      shown.set(issue.id, view);
    }
  }
  return shown;
}
