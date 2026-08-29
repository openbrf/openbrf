import type { ArchivedDocument, DocumentAudience } from "./documents-api";

/**
 * The archive as a shelf: what is grouped with what, and how a file is
 * described.
 *
 * Pure, and apart from the screen, because these are the parts worth testing on
 * their own: the grouping is what a board reads the archive by, and the minutes
 * rule below is a publication guardrail rather than a piece of layout.
 */

export interface DocumentShelf {
  category: string;
  documents: readonly ArchivedDocument[];
}

/**
 * Groups documents by their binder, keeping the server's order within each.
 *
 * The categories come out in the order they are first met, which is the order
 * the API sorted them into. Sorting again here would be a second opinion about
 * an ordering the server already has, and the two would drift.
 */
export function shelvesOf(
  documents: readonly ArchivedDocument[],
): readonly DocumentShelf[] {
  const byCategory = new Map<string, ArchivedDocument[]>();

  for (const document of documents) {
    const shelf = byCategory.get(document.category);
    if (shelf === undefined) {
      byCategory.set(document.category, [document]);
    } else {
      shelf.push(document);
    }
  }

  return [...byCategory.entries()].map(([category, entries]) => ({
    category,
    documents: entries,
  }));
}

/**
 * The words that name a binder of minutes.
 *
 * Data rather than interface text: this list decides whether the publication
 * guardrail applies, and it has to keep applying when the interface is read in
 * the other language. It holds the suggestion each catalog offers, so a board
 * that took the suggestion is covered whichever language they took it in; a
 * binder they named something else entirely is a binder the board invented and
 * is theirs to publish as they see fit.
 */
const MINUTES_BINDERS: readonly string[] = ["protokoll", "minutes"];

/** Whether a binder holds minutes (protokoll). */
export function isMinutesBinder(category: string): boolean {
  return MINUTES_BINDERS.includes(category.trim().toLowerCase());
}

/**
 * The audience a document gets when its binder changes.
 *
 * Minutes are the publication guardrail this module carries: a general
 * meeting's minutes name the members who spoke and how they voted, so they
 * belong to the members unless the board decides otherwise about that
 * particular document. Choosing the minutes binder therefore takes a document
 * off the public shelf, and publishing one is then a second, deliberate act.
 *
 * It only ever narrows. A board that picks the minutes binder for a document
 * already kept to itself keeps it there.
 */
export function audienceForBinder(
  category: string,
  audience: DocumentAudience,
): DocumentAudience {
  return isMinutesBinder(category) && audience === "PUBLIC"
    ? "MEMBER"
    : audience;
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
 * Rounded here rather than in the markup so the screen has one string to place
 * and the rounding is testable. Kilobytes are whole - nobody reads a document
 * differently for 41.3 kB than for 41 - and megabytes keep one decimal, which
 * is the difference between a file that opens and one an old phone struggles
 * with.
 */
export function fileSizeOf(byteSize: number): FileSize {
  if (byteSize < KIB) {
    return { unit: "bytes", size: String(byteSize) };
  }
  if (byteSize < KIB * KIB) {
    return { unit: "kilobytes", size: String(Math.round(byteSize / KIB)) };
  }
  return {
    unit: "megabytes",
    size: (byteSize / (KIB * KIB)).toFixed(1),
  };
}
