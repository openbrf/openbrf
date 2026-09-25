import type { TranslationKey } from "../i18n/translation-key";
import {
  type BinderAudience,
  type BinderEntry,
  type BinderFiler,
  BINDER_KINDS,
  type BinderKind,
  type BoardBinderEntry,
} from "./apartment-binder-api";

/**
 * What each kind of entry is: its word, who files it, whether it carries a day
 * and who it is for unless the filer says otherwise.
 *
 * Pure, and apart from the screen, because these are the rules worth reading on
 * their own. Three of them are the server's and are restated here so the form
 * does not offer what would be refused: a permission under BRL 7 kap. 7 § is
 * the board's own decision and a tenant-owner is offered no such option, and
 * one without the day it was taken is refused. The restatement is not the
 * enforcement - the service and the database both refuse the combination - it
 * is what keeps a household from filling in a form that could only be turned
 * down.
 */

/**
 * The kinds the board files and nobody else.
 *
 * What the binder is worth to the next household is that a permission means the
 * board said so. A tenant-owner able to file one would put two things on the
 * screen that look alike and mean different things.
 */
const KINDS_THE_BOARD_FILES_ALONE: readonly BinderKind[] = [
  "ALTERATION_PERMISSION",
];

/**
 * The kinds that must carry their day.
 *
 * A permission is a decision, and a decision has the day it was taken: without
 * it the entry could not be read against an alteration the association later
 * has to judge under BRL 7 kap. 12 a § or 18 § 9. The other kinds carry a date
 * where there is one to carry.
 */
const KINDS_THAT_CARRY_THEIR_DAY: readonly BinderKind[] = [
  "ALTERATION_PERMISSION",
];

/**
 * Who an entry is for unless the filer says otherwise.
 *
 * The permission is the tenant-owners' own: it is granted to the
 * bostadsrattshavare, it carries the conditions they answer for, and a
 * second-hand tenant living there has no part in it. Everything else describes
 * the home itself - a drawing, an inspection, the manual for what is installed
 * - and is the whole household's by default. Written out per kind rather than
 * as a rule with one exception, so a kind added to the enum has to be decided
 * about rather than inheriting somebody else's answer.
 */
const DEFAULT_AUDIENCE: Readonly<Record<BinderKind, BinderAudience>> = {
  DRAWING: "HOUSEHOLD",
  ALTERATION_PERMISSION: "TENANT_OWNERS",
  WORK_RECORD: "HOUSEHOLD",
  INSPECTION: "HOUSEHOLD",
  INSTRUCTIONS: "HOUSEHOLD",
  OTHER: "HOUSEHOLD",
};

/**
 * The word for each kind.
 *
 * Written out rather than composed, so a kind added to the enum without a word
 * here is a build failure rather than a raw enum value on somebody's screen.
 * The keys are the ones the data subject access report already reads.
 */
export const KIND_LABEL: Readonly<Record<BinderKind, TranslationKey>> = {
  DRAWING: "apartmentBinder.kind.DRAWING",
  ALTERATION_PERMISSION: "apartmentBinder.kind.ALTERATION_PERMISSION",
  WORK_RECORD: "apartmentBinder.kind.WORK_RECORD",
  INSPECTION: "apartmentBinder.kind.INSPECTION",
  INSTRUCTIONS: "apartmentBinder.kind.INSTRUCTIONS",
  OTHER: "apartmentBinder.kind.OTHER",
};

/** The word for each audience. */
export const AUDIENCE_LABEL: Readonly<Record<BinderAudience, TranslationKey>> =
  {
    TENANT_OWNERS: "apartmentBinder.audience.TENANT_OWNERS",
    HOUSEHOLD: "apartmentBinder.audience.HOUSEHOLD",
  };

/** What each audience means, in a sentence beside the choice. */
export const AUDIENCE_HINT: Readonly<Record<BinderAudience, TranslationKey>> = {
  TENANT_OWNERS: "apartmentBinder.audienceHint.TENANT_OWNERS",
  HOUSEHOLD: "apartmentBinder.audienceHint.HOUSEHOLD",
};

/** In what capacity an entry was filed, as a household is told it. */
export const FILED_AS_LABEL: Readonly<Record<BinderFiler, TranslationKey>> = {
  BOARD: "apartmentBinder.filedAs.BOARD",
  TENANT_OWNER: "apartmentBinder.filedAs.TENANT_OWNER",
};

/** Whether this kind is filed by the board alone. */
export function isTheBoards(kind: BinderKind): boolean {
  return KINDS_THE_BOARD_FILES_ALONE.includes(kind);
}

/** Whether this kind must carry the day it is dated. */
export function carriesItsDay(kind: BinderKind): boolean {
  return KINDS_THAT_CARRY_THEIR_DAY.includes(kind);
}

/** Who an entry of this kind is for unless the filer says otherwise. */
export function defaultAudienceFor(kind: BinderKind): BinderAudience {
  return DEFAULT_AUDIENCE[kind];
}

/** The kinds this filer is offered, in the order they are shown. */
export function kindsFiledBy(filer: "BOARD" | "TENANT_OWNER"): BinderKind[] {
  return BINDER_KINDS.filter((kind) => filer === "BOARD" || !isTheBoards(kind));
}

/** One kind's entries, in the order the server sent them. */
export interface BinderGroup<Entry> {
  kind: BinderKind;
  entries: readonly Entry[];
}

/**
 * Groups a binder's entries by kind, keeping the server's order within each.
 *
 * The kinds come out in the enum's own order rather than in the order they were
 * met, because that order is what the binder is read by: the drawings, then
 * what the board permitted, then what was done. A kind nothing was filed under
 * is left out rather than shown empty - a binder is a binder and not a form.
 */
export function groupByKind<Entry extends BinderEntry | BoardBinderEntry>(
  entries: readonly Entry[],
): BinderGroup<Entry>[] {
  return BINDER_KINDS.map((kind) => ({
    kind,
    entries: entries.filter((entry) => entry.kind === kind),
  })).filter((group) => group.entries.length > 0);
}

/** One kibibyte, and the point at which the next unit reads better. */
const KIB = 1024;

export interface FileSize {
  unit: "bytes" | "kilobytes" | "megabytes";
  /** Already rounded for display: whole kilobytes, one decimal megabyte. */
  size: string;
}

/**
 * A file size, in the unit that says the most about it.
 *
 * The archive's own rounding, on the archive's reasoning: kilobytes are whole,
 * and megabytes keep one decimal, which is the difference between a file that
 * opens and one an old phone struggles with.
 */
export function fileSizeOf(byteSize: number): FileSize {
  if (byteSize < KIB) {
    return { unit: "bytes", size: String(byteSize) };
  }
  if (byteSize < KIB * KIB) {
    return { unit: "kilobytes", size: String(Math.round(byteSize / KIB)) };
  }
  return { unit: "megabytes", size: (byteSize / (KIB * KIB)).toFixed(1) };
}
