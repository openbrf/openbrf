/**
 * Who pays for an issue, and who maintains which part of a home (ADR 0054,
 * decisions 26 and 27 of the issue module plan). Written once here, because
 * both applications read them and a list spelled out in each would drift.
 */

/**
 * Who bears the cost of an issue (kostnadsansvar), as a handler records it.
 *
 * - `ASSOCIATION`: Föreningen.
 * - `TENANT_OWNER`: Bostadsrättshavaren.
 * - `UNCLEAR`: Oklart - a handler has looked and cannot yet say.
 *
 * An issue nobody has decided this for carries none. Never an amount: what a
 * tenant-owner is charged is a member charge (debitering), and a second place
 * holding a sum would be a second answer to what the member owes.
 */
export const ISSUE_COST_RESPONSIBILITIES = [
  "ASSOCIATION",
  "TENANT_OWNER",
  "UNCLEAR",
] as const;

export type IssueCostResponsibility =
  (typeof ISSUE_COST_RESPONSIBILITIES)[number];

/**
 * Who maintains a part of the home or the building (underhållsansvar), as one
 * line of the association's responsibility guide (ansvarsfördelning) states
 * it. Two values and no "unclear": the guide is the association's reading of
 * its own bylaws, and a line it cannot place says so in its note.
 */
export const MAINTENANCE_RESPONSIBILITIES = [
  "ASSOCIATION",
  "TENANT_OWNER",
] as const;

export type MaintenanceResponsibility =
  (typeof MAINTENANCE_RESPONSIBILITIES)[number];

/** How much the board may write into its responsibility guide. */
export const RESPONSIBILITY_GUIDE_LIMITS = {
  /** Lines in the guide. HSB's normalstadgar list a few dozen. */
  items: 80,
  /** The part a line is about, such as "Golvbrunn, rensning". */
  part: 120,
  /** A note on a line, such as "Ytterdörrens utsida är föreningens". */
  note: 300,
} as const;
