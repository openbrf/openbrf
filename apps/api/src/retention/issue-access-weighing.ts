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

/** What of a weighing the report reads: the reason, and a copy given in part. */
export const WEIGHING_SELECT = {
  withheldBecause: true,
  givenText: true,
} as const satisfies Prisma.IssueAccessWeighingSelect;

/** A weighing with the text it weighs, for `weighingsByText`. */
export const KEYED_WEIGHING_SELECT = {
  part: true,
  messageId: true,
  noteId: true,
  ...WEIGHING_SELECT,
} as const satisfies Prisma.IssueAccessWeighingSelect;

/** One text's weighing, as the report and the board's screen read it. */
export interface StandingWeighing {
  withheldBecause: IssueAccessWithholdingReason | null;
  givenText: string | null;
}

/** A weighing row as read with the text it weighs. */
export interface KeyedWeighing extends StandingWeighing {
  part: IssueAccessPart;
  messageId: string | null;
  noteId: string | null;
}

/** How much of a text a weighing keeps back: whole, in part, or nothing. */
function restriction(weighing: StandingWeighing): number {
  if (weighing.withheldBecause === null) {
    return 0;
  }
  return weighing.givenText === null ? 2 : 1;
}

/**
 * The weighing that stands of the rows on one text for one report: the most
 * restrictive of them. The unique index `issue_access_weighing_text_key` holds
 * a text to one row per report; should two ever stand, a text left out whole
 * outweighs one given in part, which outweighs one given whole, and two copies
 * given in part that differ leave the text out whole, since neither copy is
 * known to leave out what the other does. So a second row never gives what
 * the first left out. Undefined where there is no row: the text is unweighed.
 */
export function strictestWeighing(
  rows: readonly StandingWeighing[],
): StandingWeighing | undefined {
  let strictest: StandingWeighing | undefined;
  for (const row of rows) {
    if (strictest === undefined || restriction(row) > restriction(strictest)) {
      strictest = row;
    } else if (
      restriction(row) === 1 &&
      restriction(strictest) === 1 &&
      row.givenText !== strictest.givenText
    ) {
      strictest = {
        withheldBecause: strictest.withheldBecause,
        givenText: null,
      };
    }
  }
  return strictest;
}

/**
 * The weighing that stands of each text on one report, by `weighingKey`, the
 * most restrictive where a text has more than one row (`strictestWeighing`).
 */
export function weighingsByText(
  rows: readonly KeyedWeighing[],
): Map<string, StandingWeighing> {
  const byText = new Map<string, StandingWeighing[]>();
  for (const row of rows) {
    const key = weighingKey(row.part, row.messageId ?? row.noteId);
    byText.set(key, [...(byText.get(key) ?? []), row]);
  }
  return new Map(
    [...byText].flatMap(([key, standing]) => {
      const strictest = strictestWeighing(standing);
      return strictest === undefined ? [] : [[key, strictest] as const];
    }),
  );
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
