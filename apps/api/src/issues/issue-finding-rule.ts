import {
  type IssueFindingKind,
  latestFindingTargetDate,
} from "@openbrf/shared";

import { IssueError } from "./issue.error";

/**
 * Holds the target date of an issue that is a finding of an inspection (decision
 * 31) to the one date the law sets.
 *
 * A finding has a real target date, so it cannot be left without one. A lift's
 * must fall no later than a month after the inspection (BFS 2025:11 1 kap.
 * 17 §); an OVK or fire finding has the date the handler chose, and the law
 * names none to hold it to. A date in the past is allowed, as it is for any
 * issue: a handler recording a finding that is already late is telling the
 * truth, and the issue then stands as overdue.
 *
 * Asked by the mark itself and by every change of the target date afterwards,
 * so the two cannot disagree.
 *
 * @param targetDate The target date as a calendar day, `YYYY-MM-DD`, or null.
 * @param inspectedOn The day of the inspection, `YYYY-MM-DD`.
 */
export function requireFindingTargetDate(
  kind: IssueFindingKind,
  inspectedOn: string,
  targetDate: string | null,
): void {
  if (targetDate === null) {
    throw new IssueError(
      "A finding of an inspection needs a target date.",
      "finding-needs-target-date",
    );
  }
  const latest = latestFindingTargetDate(kind, inspectedOn);
  if (latest !== null && targetDate > latest) {
    throw new IssueError(
      "A lift's remaining faults are to be put right within a month of the inspection.",
      "finding-target-date-too-late",
    );
  }
}
