/**
 * The aid on the fee screen: what a yearly total would come to per apartment.
 *
 * A board typing eighty amounts has them on a spreadsheet already, and the
 * spreadsheet did one arithmetic: the year's budget divided by the
 * participation shares. This does that arithmetic on the screen so the figures
 * can be checked and accepted rather than retyped.
 *
 * ## It suggests and it never decides
 *
 * Nothing this computes is stored, nothing is derived at read time, and no
 * yearly total is kept anywhere. What is stored is the monthly amount the board
 * accepted or overwrote, which is what BRL 9 kap. 13 § makes the board
 * responsible for. The word andelstal occurs nowhere in bostadsrattslagen: BRL
 * 9 kap. 5 § forsta stycket 5 makes the basis for calculating the arsavgift a
 * matter for each association's stadgar, so a platform that apportioned by it
 * on its own would be enforcing one bylaws construct as if it were statute.
 *
 * The screen says so in as many words, because the risk this file carries is a
 * board believing the platform is maintaining an apportionment it is not: the
 * suggestion recomputes on demand and never on read, and an amount that has
 * drifted from it is the board's own figure rather than an error.
 *
 * ## Integer arithmetic, and the remainder is visible
 *
 * The total is taken in ore and the shares in hundred-millionths, both as
 * `BigInt`, so the suggestion is exact to the ore rather than nearly right. A
 * division that does not come out exactly is truncated rather than rounded, and
 * {@link suggestMonthlyAmounts} answers with what is left over so the screen can
 * say that the suggestions add to slightly less than the total asked for. That
 * is the honest shape: this product refuses a malformed amount rather than
 * rounding one, and an aid that quietly rounded would be teaching the opposite.
 */

/** One whole share, in hundred-millionths: the scale of `Decimal(12, 8)`. */
const SHARE_SCALE = 100_000_000n;

/** Months in a year, which is what a yearly total is divided across. */
const MONTHS = 12n;

export interface ShareSuggestion {
  apartmentId: string;
  /**
   * What this apartment would pay per calendar month, as a decimal string, or
   * null where no participation share is recorded for it.
   *
   * Null rather than zero, because the two are different answers: an apartment
   * with no share recorded is one the aid cannot speak for, and a suggestion of
   * nothing would read as a decision.
   */
  monthlyAmount: string | null;
}

export interface ShareSuggestions {
  suggestions: ShareSuggestion[];
  /**
   * The ore the suggestions do not account for, as a decimal string.
   *
   * Two things land here and the screen says so: the part of the year's total
   * that falls on apartments with no share recorded, and whatever the division
   * truncated. Never distributed silently onto somebody's fee.
   */
  unallocated: string;
}

/**
 * What each apartment would pay per month for a stated yearly total.
 *
 * @param yearlyTotal The year's total, as a decimal string of kronor and ore.
 * @param apartments Each apartment and its recorded participation share, as the
 *   register holds them.
 */
export function suggestMonthlyAmounts(
  yearlyTotal: string,
  apartments: readonly {
    apartmentId: string;
    participationShare: string | null;
  }[],
): ShareSuggestions | null {
  const totalOre = oreOf(yearlyTotal);
  if (totalOre === null) {
    // Not a sum, so there is nothing to suggest. The screen keeps whatever the
    // board typed and offers no figures rather than offering wrong ones.
    return null;
  }

  let allocated = 0n;
  const suggestions = apartments.map((apartment): ShareSuggestion => {
    const share = scaledShareOf(apartment.participationShare);
    if (share === null) {
      return { apartmentId: apartment.apartmentId, monthlyAmount: null };
    }

    /*
     * The year's ore times the share, then divided across the months. In that
     * order, because dividing by twelve first would throw away up to eleven ore
     * of every apartment's year before the share was even applied.
     */
    const monthlyOre = (totalOre * share) / (SHARE_SCALE * MONTHS);
    allocated += monthlyOre * MONTHS;

    return {
      apartmentId: apartment.apartmentId,
      monthlyAmount: formatOre(monthlyOre),
    };
  });

  return { suggestions, unallocated: formatOre(totalOre - allocated) };
}

/** A decimal amount as whole ore, or null where it is not a sum. */
function oreOf(amount: string): bigint | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(amount.trim());
  const kronor = match?.[1];
  if (kronor === undefined) {
    return null;
  }
  return BigInt(kronor) * 100n + BigInt((match?.[2] ?? "").padEnd(2, "0"));
}

/** A participation share in hundred-millionths, or null where none is recorded. */
function scaledShareOf(share: string | null): bigint | null {
  if (share === null) {
    return null;
  }
  const match = /^(\d{1,4})(?:\.(\d{1,8}))?$/.exec(share.trim());
  const whole = match?.[1];
  if (whole === undefined) {
    return null;
  }
  const scaled =
    BigInt(whole) * SHARE_SCALE + BigInt((match?.[2] ?? "").padEnd(8, "0"));
  return scaled === 0n ? null : scaled;
}

/** Whole ore as the decimal string a `DECIMAL(14, 2)` renders. */
function formatOre(ore: bigint): string {
  const negative = ore < 0n;
  const absolute = negative ? -ore : ore;
  return `${negative ? "-" : ""}${String(absolute / 100n)}.${String(
    absolute % 100n,
  ).padStart(2, "0")}`;
}
