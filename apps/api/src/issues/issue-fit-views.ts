import {
  compareLocalDays,
  formatDateColumn,
  type IssueEntryAnswer,
  type IssueFindingKind,
  localDayOfColumn,
  type LocalDay,
} from "@openbrf/shared";

/**
 * A common-area place as an issue names it: the identifier and the board's own
 * words for it (decision 30).
 */
export interface IssuePlaceRef {
  id: string;
  name: string;
}

/**
 * The resident's entry permission on an issue (tillträde, decision 29), as the
 * reporter and the handlers read it.
 *
 * The same for both: it is the resident's own answer about their own home, and
 * the handler needs every word of it to send someone to the door. `expired` is
 * computed when the row is read, never stored: a permission that has lapsed is
 * still shown, as lapsed, until the issue closes and clears it.
 *
 * Never on `mcp` or `ai` (ADR 0056): no action's shape carries it.
 */
export interface IssueEntryView {
  answer: IssueEntryAnswer;
  /** How to get in, or null. Always null for a no. */
  note: string | null;
  /** Whether there are pets in the home; null for a no. */
  pets: boolean | null;
  /** Whether the master key may be used; null for a no. */
  masterKey: boolean | null;
  /** The last day the permission stands, `YYYY-MM-DD`, or null for none. */
  until: string | null;
  expired: boolean;
}

/**
 * The mark of an inspection finding on an issue (decision 31), as handlers read
 * it. The protocol is one of the issue's handler-only files, named so the
 * screen can show which; it is null once the file has been removed from the
 * issue. Its date is the issue's own target date.
 */
export interface IssueFindingView {
  kind: IssueFindingKind;
  /** The day of the inspection, `YYYY-MM-DD`. */
  inspectedOn: string;
  protocol: { attachmentId: string; fileName: string } | null;
}

/** The columns an entry permission is read from. */
export interface EntryColumns {
  entryAnswer: IssueEntryAnswer | null;
  entryNote: string | null;
  entryPets: boolean | null;
  entryMasterKey: boolean | null;
  entryUntil: Date | null;
}

/** The columns a finding is read from. */
export interface FindingRecord {
  kind: IssueFindingKind;
  inspectedOn: Date;
  protocolAttachment: { id: string; file: { fileName: string } } | null;
}

/** The entry permission an issue holds, or null while nobody has answered. */
export function toEntryView(
  issue: EntryColumns,
  today: LocalDay,
): IssueEntryView | null {
  if (issue.entryAnswer === null) {
    return null;
  }
  return {
    answer: issue.entryAnswer,
    note: issue.entryNote,
    pets: issue.entryPets,
    masterKey: issue.entryMasterKey,
    until: formatDateColumn(issue.entryUntil),
    expired:
      issue.entryUntil !== null &&
      compareLocalDays(localDayOfColumn(issue.entryUntil), today) < 0,
  };
}

export function toFindingView(
  finding: FindingRecord | null,
): IssueFindingView | null {
  if (finding === null) {
    return null;
  }
  return {
    kind: finding.kind,
    inspectedOn: formatDateColumn(finding.inspectedOn) ?? "",
    protocol:
      finding.protocolAttachment === null
        ? null
        : {
            attachmentId: finding.protocolAttachment.id,
            fileName: finding.protocolAttachment.file.fileName,
          },
  };
}

/** Every column an entry permission is cleared by, as one update's data. */
export const NO_ENTRY_PERMISSION = {
  entryAnswer: null,
  entryNote: null,
  entryPets: null,
  entryMasterKey: null,
  entryUntil: null,
} as const;

/** The columns a read selects to build {@link toEntryView}. */
export const ENTRY_SELECT = {
  entryAnswer: true,
  entryNote: true,
  entryPets: true,
  entryMasterKey: true,
  entryUntil: true,
} as const;

/** The select that builds {@link toFindingView}. */
export const FINDING_SELECT = {
  kind: true,
  inspectedOn: true,
  protocolAttachment: {
    select: { id: true, file: { select: { fileName: true } } },
  },
} as const;
