import type {
  DataSubjectRequestDecision,
  DataSubjectRequestKind,
  ErasureException,
  ErasureGround,
} from "../generated/prisma/enums";
import { toIsoDate } from "../address-book/address-book-view";

/**
 * What a person asked about their own data, as the board's screens show it.
 *
 * Pure, and separate from the service that writes requests, so the person view
 * and the board's overview can project them without depending on the write
 * path - the shape and the reasoning of `address-book/publication-consent.ts`.
 *
 * Erasure (art. 17), objection (art. 21) and restriction (art. 18) are one type
 * because they are one conversation with one person, answered on one clock:
 * GDPR art. 12(3) gives the association a month from the request, whichever
 * right was exercised.
 */

/** What the view functions need of a row; anything wider is ignored. */
export interface DataSubjectRequestRow {
  id: string;
  personId: string;
  kind: DataSubjectRequestKind;
  requestedOn: Date;
  ground: string;
  erasureGround: ErasureGround | null;
  issueId: string | null;
  decision: DataSubjectRequestDecision | null;
  erasureException: ErasureException | null;
  decisionGround: string | null;
  decidedAt: Date | null;
  decidedByPersonId: string | null;
  executedAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  closedByPersonId: string | null;
  recordedByPersonId: string | null;
}

export interface DataSubjectRequestView {
  requestId: string;
  personId: string;
  kind: DataSubjectRequestKind;
  requestedOn: string | null;
  /** The art. 12(3) month, derived rather than stored. */
  dueOn: string | null;
  ground: string;
  erasureGround: ErasureGround | null;
  issueId: string | null;
  decision: DataSubjectRequestDecision | null;
  erasureException: ErasureException | null;
  decisionGround: string | null;
  decidedAt: string | null;
  decidedByPersonId: string | null;
  executedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  closedByPersonId: string | null;
  recordedByPersonId: string | null;
  state: DataSubjectRequestState;
}

export type DataSubjectRequestState =
  "open" | "overdue" | "granted" | "refused" | "executed" | "closed";

/**
 * When the association owes the person an answer: one month from the request
 * (GDPR art. 12(3)).
 *
 * Calendar arithmetic, deliberately, and the one place in the retention code
 * that does not count in milliseconds. Every other clock here bounds a
 * technical window and is measured in real elapsed time; art. 12(3) says "one
 * month", which is a calendar word, and a month counted as 30 days would answer
 * a 31 January request on 2 March rather than at the end of February.
 *
 * The end of a short month is where "one month" stops being obvious. A request
 * made on 31 January has no 31 February to land on, so it is due on the last
 * day of February - the reading that keeps the answer inside the month the
 * article gives rather than spilling into the next one.
 *
 * UTC fields throughout, matching the @db.Date column, so the answer does not
 * move by a day for a request recorded late in a Swedish evening.
 */
export function dueOn(requestedOn: Date): Date {
  const year = requestedOn.getUTCFullYear();
  const month = requestedOn.getUTCMonth();
  const day = requestedOn.getUTCDate();

  // Day 0 of the month after the target is the last day of the target month.
  const lastDayOfTargetMonth = new Date(
    Date.UTC(year, month + 2, 0),
  ).getUTCDate();

  return new Date(
    Date.UTC(
      year,
      month + 1,
      Math.min(day, lastDayOfTargetMonth),
      requestedOn.getUTCHours(),
      requestedOn.getUTCMinutes(),
      requestedOn.getUTCSeconds(),
      requestedOn.getUTCMilliseconds(),
    ),
  );
}

/**
 * What the screens say about one request.
 *
 * Six states, tested in this order:
 *
 *   - `closed`: nothing left to do. An objection withdrawn, a restriction
 *     lifted, an erasure executed or overtaken by a move-in.
 *   - `executed`: granted and carried out by the purge, but not yet closed,
 *     which is the window of a single night.
 *   - `refused` / `granted`: decided. A refusal is a final answer with its
 *     reasons on the row (art. 12(4)); a grant stays visible until the act it
 *     authorises has happened.
 *   - `overdue`: undecided and past the art. 12(3) month. Still owed, exactly
 *     as an overdue breach notification is still owed.
 *   - `open`: undecided and inside the month.
 *
 * `executed` is tested before the decision because a purge sets executedAt and
 * closedAt in the same transaction; the ordering matters only for a row where
 * one was written without the other, which is a state worth showing honestly
 * rather than hiding behind "granted".
 */
export function requestState(
  row: Pick<
    DataSubjectRequestRow,
    "requestedOn" | "decision" | "executedAt" | "closedAt"
  >,
  now: Date,
): DataSubjectRequestState {
  if (row.closedAt !== null) {
    return "closed";
  }
  if (row.executedAt !== null) {
    return "executed";
  }
  if (row.decision === "REFUSED") {
    return "refused";
  }
  if (row.decision === "GRANTED") {
    return "granted";
  }
  return dueOn(row.requestedOn).getTime() < now.getTime() ? "overdue" : "open";
}

export function toDataSubjectRequestView(
  row: DataSubjectRequestRow,
  now: Date,
): DataSubjectRequestView {
  return {
    requestId: row.id,
    personId: row.personId,
    kind: row.kind,
    requestedOn: toIsoDate(row.requestedOn),
    dueOn: toIsoDate(dueOn(row.requestedOn)),
    ground: row.ground,
    erasureGround: row.erasureGround,
    issueId: row.issueId,
    decision: row.decision,
    erasureException: row.erasureException,
    decisionGround: row.decisionGround,
    decidedAt: toIsoDate(row.decidedAt),
    decidedByPersonId: row.decidedByPersonId,
    executedAt: toIsoDate(row.executedAt),
    closedAt: toIsoDate(row.closedAt),
    closeReason: row.closeReason,
    closedByPersonId: row.closedByPersonId,
    recordedByPersonId: row.recordedByPersonId,
    state: requestState(row, now),
  };
}
