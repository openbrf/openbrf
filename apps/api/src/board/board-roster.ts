import {
  type ConsentDates,
  hasStandingConsent,
} from "../address-book/publication-consent";
import type { BoardPositionType } from "../generated/prisma/enums";

/**
 * The board roster (styrelselista): who the association's board is, as the
 * association publishes it.
 *
 * Pure, and separate from the query for the reason the address book's masking
 * rules are separate from the service that reads rows: deciding whose name may
 * be published is the highest-stakes behaviour this module has, and a rule that
 * needs a database to exercise is a rule nobody tests exhaustively.
 *
 * Two things are withheld here and neither is a preference.
 *
 *   A name appears only with a standing publication consent
 *   (publiceringssamtycke) for this scope. Consent is the legal basis for
 *   putting personal data on a page the association publishes (GDPR art. 6.1
 *   a), it is per person and per scope, and agreeing to a photograph is not
 *   agreeing to this. A person who has never been asked and a person who has
 *   withdrawn are the same answer to a page: not published.
 *
 *   Protected personal data (skyddade personuppgifter) is never published,
 *   whatever consent says. Publication is what protection exists to prevent,
 *   and a person under threat consenting to a roster is not a decision this
 *   platform will act on: the whole point of the register flag is that the
 *   association carries the rule rather than the person carrying it.
 *
 * What is published is a name and an elected position. The output type has no
 * place to put anything else - no address, no contact detail, no apartment, no
 * identifier - so a caller cannot be handed one by a mapping mistake, in the
 * same way a resident-facing address book row cannot carry contact data.
 */

/** Positions in the order a roster is read: seniority, not the enum's order. */
export const ROSTER_POSITIONS = [
  "CHAIR",
  "BOARD_MEMBER",
  "DEPUTY_BOARD_MEMBER",
] as const satisfies readonly BoardPositionType[];

/**
 * Fails to compile unless the order above names every position in the schema.
 *
 * The `satisfies` proves each entry is a real position; this proves the
 * reverse. A position added to the Prisma enum and not given a place in the
 * order would otherwise be sorted last by accident rather than by decision, on
 * the one page the association publishes about its own board.
 */
export type EveryPositionIsOrdered<
  Unordered extends never = Exclude<
    BoardPositionType,
    (typeof ROSTER_POSITIONS)[number]
  >,
> = Unordered;

/**
 * One held seat, as the roster reads it out of the register.
 *
 * The name is in two parts because that is how the register holds it, and the
 * consent rows are the whole of what decides publication. There is deliberately
 * no field for a contact detail: this shape is what the query may select, and a
 * cipher column has nowhere to land in it.
 */
export interface BoardSeat {
  position: BoardPositionType;
  firstName: string;
  lastName: string;
  protectedPersonalData: boolean;
  /** Every BOARD_ROSTER consent row this person holds, in any order. */
  consents: readonly ConsentDates[];
}

/** One line of the published roster. A name and a position, and nothing else. */
export interface BoardRosterEntry {
  position: BoardPositionType;
  name: string;
}

/**
 * The seats that may be published, in the order they are read.
 *
 * Seniority first, then by name, so a roster is stable between renderings and
 * does not reorder itself because a row was written on a different day. Two
 * people holding the same position appear alphabetically by surname, which is
 * how a housing cooperative prints its board in its annual report.
 *
 * A person holding two seats appears twice, once under each. That is the
 * register's own answer and the roster does not improve on it: a deputy who
 * has been co-opted as a board member holds both, and collapsing them would be
 * this module deciding which of the two the association meant.
 */
export function publishableRoster(
  seats: readonly BoardSeat[],
): BoardRosterEntry[] {
  return seats
    .filter((seat) => isPublishable(seat))
    .toSorted(
      (one, other) =>
        rank(one.position) - rank(other.position) ||
        // By surname, which is how a housing cooperative prints its board in
        // its annual report, and in the Swedish collation - where a, a and o
        // with their diacritics are letters of their own and sort after z
        // rather than beside their bare forms.
        one.lastName.localeCompare(other.lastName, "sv") ||
        one.firstName.localeCompare(other.firstName, "sv"),
    )
    .map((seat) => ({
      position: seat.position,
      name: `${seat.firstName} ${seat.lastName}`.trim(),
    }));
}

/**
 * Whether this seat's holder may be named on a published page.
 *
 * Protected personal data is read first and answers on its own, so no ordering
 * of the two conditions can produce a page carrying a protected person's name.
 */
function isPublishable(seat: BoardSeat): boolean {
  if (seat.protectedPersonalData) {
    return false;
  }
  return hasStandingConsent(seat.consents, "BOARD_ROSTER");
}

function rank(position: BoardPositionType): number {
  const at = ROSTER_POSITIONS.indexOf(position);
  // A position the order does not name sorts last rather than first. It cannot
  // happen while the type above compiles; if it ever does, the answer that puts
  // an unplaced position at the end is the one that reads least like a claim.
  return at === -1 ? ROSTER_POSITIONS.length : at;
}
