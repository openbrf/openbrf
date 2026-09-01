import {
  compareLocalDays,
  type LocalDay,
} from "../bookings/stockholm-calendar";

/**
 * How long a member's written authority for a proxy holder (fullmakt) holds.
 *
 * EFL 6 kap. 4 § andra stycket, which BRL 9 kap. 14 § leaves standing: the
 * proxy holder is to have a proxy authorisation that is written, dated and
 * signed by the member, and "en fullmakt galler hogst ett ar fran utfardandet".
 * So the date the member wrote on it is not a formality on the row - it is the
 * whole of what makes the authority current, and a meeting held a year and a
 * day later is one the proxy holder may not vote at.
 *
 * Its own module, and pure, because the answer is needed twice and must not be
 * allowed to differ. The board is refused a stale proxy authorisation when it
 * registers one, and the voting register asks again when it is drawn up - the
 * meeting day can be moved after an authorisation was registered, and a register
 * that trusted the registration would then seat a proxy holder whose authority
 * had run out.
 *
 * ## What this module does not decide
 *
 * That the proxy authorisation exists, that it is written, and that the member
 * signed it. A document signed under the Economic Associations Act may be
 * signed with an advanced electronic signature (EFL 1 kap. 15 §), which is a
 * trust service this platform does not provide, so nothing here produces or
 * verifies a signature. What the board records is that it saw the paper and the
 * date on it; the paper is what stands behind the authorisation.
 */

/** Days in a month of a particular year, from the platform's own calendar. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The last day a proxy authorisation issued on the given day still holds.
 *
 * One year on, that day included: "hogst ett ar fran utfardandet" measures from
 * the day of issue, so an authority dated the 12th of May 2027 covers a meeting
 * on the 12th of May 2028 and not one on the 13th.
 *
 * The day is clamped to the length of the month in the following year, so an
 * authority dated 29 February runs to the 28th in the common year after it.
 * Clamping down rather than rolling into March is the reading that cannot extend
 * an authority past a year - the direction that matters, because the far side of
 * this boundary is somebody voting who may not.
 */
export function proxyAuthorityRunsUntil(authorisedOn: LocalDay): LocalDay {
  const year = authorisedOn.year + 1;
  return {
    year,
    month: authorisedOn.month,
    day: Math.min(authorisedOn.day, daysInMonth(year, authorisedOn.month)),
  };
}

/** Why a stated authority date cannot support a vote at a meeting. */
export type ProxyAuthorityProblem =
  "proxy-authority-not-yet-issued" | "proxy-authority-expired";

/**
 * Whether a proxy authorisation issued on one day still holds on a meeting day,
 * and why not where it does not.
 *
 * Both ends are checked, and the first is not a formality. An authority dated
 * after the meeting is not an authority the meeting can act on: EFL 6 kap. 4 §
 * has the member sign it, and a member cannot have signed on a day that has not
 * arrived. It is also the shape a mis-keyed year takes - 2028 for 2027 - which
 * would otherwise read as an authority with an unusually long life rather than
 * as the mistake it is.
 *
 * Compared as calendar dates throughout. Both sides come from `@db.Date`
 * columns, so both are read back at midnight UTC and are the same kind of thing;
 * comparing them as instants would ask a question about hours, which is the
 * defect `statutory-date.ts` sets out at length.
 */
export function proxyAuthorityProblem(
  authorisedOn: LocalDay,
  meetingDay: LocalDay,
): ProxyAuthorityProblem | null {
  if (compareLocalDays(authorisedOn, meetingDay) > 0) {
    return "proxy-authority-not-yet-issued";
  }
  if (compareLocalDays(proxyAuthorityRunsUntil(authorisedOn), meetingDay) < 0) {
    return "proxy-authority-expired";
  }
  return null;
}

/** Whether the authority holds on the meeting day. */
export function isProxyAuthorityCurrent(
  authorisedOn: LocalDay,
  meetingDay: LocalDay,
): boolean {
  return proxyAuthorityProblem(authorisedOn, meetingDay) === null;
}
