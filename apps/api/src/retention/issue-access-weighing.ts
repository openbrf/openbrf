import {
  type IssueAccessPart,
  type IssueAccessWithholdingReason,
  issueAccessPartHasId,
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

/** Oldest first, as the issue lists them. */
export const WORK_ORDER_ORDER = [
  { createdAt: "asc" },
  { id: "asc" },
] as const satisfies Prisma.WorkOrderOrderByWithRelationInput[];

/**
 * What of a work order a report reads: whom it went to and when (art.
 * 15(1)(c)), whether it went, and its text, which the report gives as the
 * board weighed it (ADR 0057, question 7). Never the address it went to, nor
 * who sent it.
 */
export const REPORT_WORK_ORDER_SELECT = {
  id: true,
  recipientName: true,
  body: true,
  redactedAt: true,
  createdAt: true,
  deliveryStatus: true,
  deliveryFailure: true,
  // Whether the contractor was given a link, and how many of the issue's
  // photographs it showed them (ADR 0055): from the record the handler's acts
  // leave, which a changed choice or a removed file does not shorten.
  _count: { select: { links: true, exposures: true } },
} as const satisfies Prisma.WorkOrderSelect;

/**
 * What of a work order the board reads to weigh it: its text, and whom it went
 * to so one can be told from another. Never the address, nor who sent it.
 */
export const WEIGHED_WORK_ORDER_SELECT = {
  id: true,
  recipientName: true,
  body: true,
  redactedAt: true,
  createdAt: true,
} as const satisfies Prisma.WorkOrderSelect;

/**
 * One text on an issue: the part, and for a message, a note or a work order
 * its identifier. The description and the location are one each.
 */
export function weighingKey(part: IssueAccessPart, id: string | null): string {
  return issueAccessPartHasId(part) ? `${part}:${id ?? ""}` : part;
}

/** The identifier a weighing row names its text by, for `weighingKey`. */
export function weighedTextId(weighing: {
  messageId: string | null;
  noteId: string | null;
  workOrderId: string | null;
}): string | null {
  return weighing.messageId ?? weighing.noteId ?? weighing.workOrderId;
}

/** What of a weighing the report reads: the reason, and a copy given in part. */
export const WEIGHING_SELECT = {
  withheldBecause: true,
  givenText: true,
} as const satisfies Prisma.IssueAccessWeighingSelect;

/** One text's weighing, as the report and the board's screen read it. */
export interface StandingWeighing {
  withheldBecause: IssueAccessWithholdingReason | null;
  givenText: string | null;
}

/**
 * A text as the report gives it: whole where the board gave it, the board's
 * copy where it gave it in part, the reason where it left it out, and nothing
 * of it where nobody weighed it yet.
 */
export function weighedText(
  text: string,
  weighing: StandingWeighing | undefined,
): ReportWeighedText {
  if (weighing === undefined) {
    return { state: "unweighed" };
  }
  if (weighing.withheldBecause === null) {
    return { state: "given", text };
  }
  return weighing.givenText === null
    ? { state: "withheld", because: weighing.withheldBecause }
    : {
        state: "givenInPart",
        text: weighing.givenText,
        because: weighing.withheldBecause,
      };
}

/** An internal note as a report carries it, weighed for that report. */
export function reportNote(
  note: Prisma.IssueNoteGetPayload<{ select: typeof WEIGHED_NOTE_SELECT }>,
  weighing: StandingWeighing | undefined,
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
 * (art. 15(1)(c)), and its text as the board weighed it for this report
 * (art. 15(3) and (4)): the handler's words to a contractor, which may name
 * somebody else.
 */
export function reportWorkOrder(
  order: Prisma.WorkOrderGetPayload<{
    select: typeof REPORT_WORK_ORDER_SELECT;
  }>,
  weighing: StandingWeighing | undefined,
): ReportIssueWorkOrder {
  return {
    workOrderId: order.id,
    recipientName: order.recipientName,
    writtenAt: order.createdAt.toISOString(),
    deliveryStatus: order.deliveryStatus,
    notSent:
      order.deliveryStatus === "FAILED" &&
      workOrderKnownNotSent(order.deliveryFailure),
    linkGiven: order._count.links > 0,
    photosShared: order._count.exposures,
    redactedAt: order.redactedAt?.toISOString() ?? null,
    content:
      order.redactedAt === null && order.body !== null && order.body !== ""
        ? weighedText(order.body, weighing)
        : null,
  };
}
