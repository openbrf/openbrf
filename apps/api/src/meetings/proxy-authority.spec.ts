import { describe, expect, it } from "vitest";

import { type LocalDay, parseLocalDay } from "../bookings/stockholm-calendar";
import {
  isProxyAuthorityCurrent,
  proxyAuthorityProblem,
  proxyAuthorityRunsUntil,
} from "./proxy-authority";

/**
 * How long a proxy authorisation holds: EFL 6 kap. 4 § andra stycket, "hogst
 * ett ar fran utfardandet".
 *
 * Both edges are asserted, and both directions. A year to the day still holds,
 * and a day past it does not - a test that only asserted the refusal would pass
 * against an implementation refusing everything older than a month, and one that
 * only asserted the acceptance would pass against one that never expires.
 */

const day = (text: string): LocalDay => {
  const parsed = parseLocalDay(text);
  if (parsed === null) {
    throw new Error(`${text} is not a calendar date.`);
  }
  return parsed;
};

describe("how long an authority runs", () => {
  it("runs to the same day one year on", () => {
    expect(proxyAuthorityRunsUntil(day("2027-05-12"))).toEqual(
      day("2028-05-12"),
    );
  });

  it("clamps a 29 February authority to the 28th in a common year", () => {
    /*
     * Clamped down and never rolled into March, and the direction is the point:
     * the far side of this boundary is somebody voting who may not, so an
     * implementation that answered the 1st of March would extend an authority
     * past its year on one date in four.
     */
    expect(proxyAuthorityRunsUntil(day("2028-02-29"))).toEqual(
      day("2029-02-28"),
    );
  });
});

describe("whether an authority covers a meeting", () => {
  const meeting = day("2027-05-12");

  it("holds on the meeting day itself", () => {
    expect(isProxyAuthorityCurrent(meeting, meeting)).toBe(true);
  });

  it("holds when it was issued exactly a year before", () => {
    expect(isProxyAuthorityCurrent(day("2026-05-12"), meeting)).toBe(true);
  });

  it("has run out a day past the year", () => {
    expect(proxyAuthorityProblem(day("2026-05-11"), meeting)).toBe(
      "proxy-authority-expired",
    );
  });

  it("refuses one dated after the meeting", () => {
    /*
     * Not a formality. EFL 6 kap. 4 § has the member sign the proxy
     * authorisation, and a member cannot have signed on a day that has not
     * arrived. It is also the shape a mis-keyed year takes - 2028 for 2027 -
     * which would otherwise read as an authority with an unusually long life
     * rather than as the mistake it is.
     */
    expect(proxyAuthorityProblem(day("2027-05-13"), meeting)).toBe(
      "proxy-authority-not-yet-issued",
    );
  });

  it("names no problem for an authority inside its year", () => {
    expect(proxyAuthorityProblem(day("2027-04-20"), meeting)).toBeNull();
  });
});
