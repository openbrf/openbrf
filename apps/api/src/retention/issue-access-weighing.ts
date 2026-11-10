import type {
  IssueAccessPart,
  IssueAccessWithholdingReason,
} from "@openbrf/shared";

import type { Prisma } from "../generated/prisma/client";
import { workOrderKnownNotSent } from "../issues/work-order-delivery";
import type {
  ReportIssueNote,
  ReportIssueWorkOrder,
  ReportWeighedText,
} from "./data-subject-report";

/**
 * How the access report reads the board's art. 15(4) weighing of an issue's
 * text (access weighing, ADR 0057), shared by the report and by the route that
 * records a weighing, so the two key a text the one way.
 */

/** Oldest first, with the identifier to order two written at one instant. */
export const ISSUE_NOTE_ORDER = [
  { createdAt: "asc" },
  { id: "asc" },
] as const satisfies Prisma.IssueNoteOrderByWithRelationInput[];

/** What of a note a report reads: never who wrote it. */
export const WEIGHED_NOTE_SELECT = {
  id: true,
  body: true,
  redactedAt: true,
  createdAt: true,
} as const satisfies Prisma.IssueNoteSelect;

/**
 * One text on an issue: the part, and for a message or a note its identifier.
 * The description and the location are one each.
 */
export function weighingKey(part: IssueAccessPart, id: string | null): string {
  return part === "MESSAGE" || part === "NOTE" ? `${part}:${id ?? ""}` : part;
}

/**
 * A text as the report gives it: whole where the board gave it, the reason
 * where it left it out, and nothing of it where nobody weighed it yet.
 */
export function weighedText(
  text: string,
  weighing:
    { withheldBecause: IssueAccessWithholdingReason | null } | undefined,
): ReportWeighedText {
  if (weighing === undefined) {
    return { state: "unweighed" };
  }
  return weighing.withheldBecause === null
    ? { state: "given", text }
    : { state: "withheld", because: weighing.withheldBecause };
}

/** An internal note as a report carries it, weighed for that report. */
export function reportNote(
  note: Prisma.IssueNoteGetPayload<{ select: typeof WEIGHED_NOTE_SELECT }>,
  weighing:
    { withheldBecause: IssueAccessWithholdingReason | null } | undefined,
): ReportIssueNote {
  return {
    noteId: note.id,
    writtenAt: note.createdAt.toISOString(),
    redactedAt: note.redactedAt?.toISOString() ?? null,
    content:
      note.redactedAt === null && note.body !== ""
        ? weighedText(note.body, weighing)
        : null,
  };
}

/**
 * A work order as both issue sections carry it: whom the issue was sent to
 * (art. 15(1)(c)), never the text, which is the handler's and may name others.
 */
export function reportWorkOrder(order: {
  recipientName: string | null;
  createdAt: Date;
  deliveryStatus: ReportIssueWorkOrder["deliveryStatus"];
  deliveryFailure: string | null;
  _count: { links: number; exposures: number };
}): ReportIssueWorkOrder {
  return {
    recipientName: order.recipientName,
    writtenAt: order.createdAt.toISOString(),
    deliveryStatus: order.deliveryStatus,
    notSent:
      order.deliveryStatus === "FAILED" &&
      workOrderKnownNotSent(order.deliveryFailure),
    linkGiven: order._count.links > 0,
    photosShared: order._count.exposures,
  };
}
