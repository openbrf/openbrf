import { localDayOfColumn } from "@openbrf/shared";

import { isResidencyHeldOn } from "../registers/held-on";

/**
 * Which charges recorded against an apartment are a given person's.
 *
 * This exists for the data subject access report (registerutdrag, GDPR art. 15)
 * and for nothing else. A charge put on an apartment carries no person at all -
 * only `apartmentId`, `chargedOn` and what was charged - so answering "which of
 * these is about the person asking" is an inference, and the inference has to be
 * made carefully or the report discloses a neighbour's, or a previous
 * household's, finances.
 *
 * `retention/holding-periods.ts` answers the same shape of question for the lien
 * notes and the terminations, and this is deliberately not that function.
 * Those are statutory rows about a tenant-ownership, so the member register
 * archive is what says whose they were. A charge is service-tier and is about
 * the household rather than the share: a repair charged on to the flat is owed
 * by the people living in it, and a resident who holds no tenant-ownership - a
 * partner, an adult child, somebody here on a second-hand contract - is exactly
 * who the charge is about. So the link is the residency, which is the record of
 * who lived there.
 *
 * ## The asymmetry that decides every edge case
 *
 * GDPR art. 15(4): the copy provided to a data subject "shall not adversely
 * affect the rights and freedoms of others". A previous household's charge on
 * this person's report is a third party's financial position, disclosed on a
 * document the association hands over. A missing charge is an omission the
 * association can correct on request.
 *
 * Those are not the same size of mistake, so a charge is theirs only if it is
 * dated on a day they held the apartment, by the rule every reader of the
 * residency table decides by (`registers/held-on.ts`): from the move-in date,
 * which is the first day held, up to the day before the move-out date, which is
 * the first day not held. A charge dated on the day somebody moved out is the
 * next household's - it is the day that household moved in - and one dated the
 * day before somebody moved in is the previous household's.
 *
 * Compared as calendar days rather than as instants. Both columns are `@db.Date`
 * and are read back as midnight UTC, which is the evening before in Stockholm
 * for part of the year - so comparing them as moments would put a charge dated
 * on a move-in day on the wrong side of the boundary for seven months of it.
 */

/** One period during which a person lived in one apartment. */
export interface ResidencyPeriod {
  apartmentId: string;
  /** The move-in date: the first day the residency is held. */
  from: Date;
  /**
   * The move-out date: the first day the residency is no longer held. Null
   * while no move-out is recorded.
   */
  until: Date | null;
}

/** A charge, as much of it as the bounding needs. */
export interface DatedApartmentCharge {
  apartmentId: string | null;
  chargedOn: Date;
}

/**
 * The charges on an apartment that fall inside one of these residencies.
 *
 * A charge with no apartment is dropped rather than guessed at: it is a charge
 * on a named person, which the report reads directly and which this function
 * would otherwise attribute to whoever it was handed.
 */
export function chargesDuringResidency<T extends DatedApartmentCharge>(
  charges: readonly T[],
  residencies: readonly ResidencyPeriod[],
): T[] {
  return charges.filter((charge) => {
    if (charge.apartmentId === null) {
      return false;
    }
    const day = localDayOfColumn(charge.chargedOn);
    return residencies.some(
      (residency) =>
        residency.apartmentId === charge.apartmentId &&
        isResidencyHeldOn(
          { movedInOn: residency.from, movedOutOn: residency.until },
          day,
        ),
    );
  });
}
