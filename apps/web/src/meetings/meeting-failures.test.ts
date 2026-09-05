import { describe, expect, it } from "vitest";

import "../i18n";
import { meetingFailureKey, type MeetingReason } from "./meeting-failures";

/**
 * Turning the module's refusal codes into sentences a board can act on.
 *
 * The map's completeness is a compile-time property - it is checked with
 * `satisfies` against the reason union - so what this file adds is the part the
 * type cannot see.
 *
 * That the five refusals which are 403s get their own sentences rather than the
 * shared one about permissions. `failureMessageKey` answers every 403 before it
 * consults a map, which is right for the guard refusing an account without the
 * capability and wrong for every one of these: each is a statement about BRL 9
 * kap. 14 § or about the association's own stadgar, and a board member at a door
 * told "your account is not allowed to change this" would go looking for
 * somebody to grant them something.
 *
 * That an account genuinely lacking the capability still gets that sentence.
 *
 * That every reason resolves to a distinct sentence where the refusals send a
 * board to different places. Five different things can be wrong with a proxy
 * authorisation and each has a different fix; one sentence about an invalid
 * authorisation would leave a board guessing which.
 */

/** Every reason the module can answer with, written out as the union is. */
const REASONS: readonly MeetingReason[] = [
  "meeting-not-found",
  "meeting-already-held",
  "meeting-not-held",
  "agenda-item-not-found",
  "date-not-a-calendar-date",
  "not-a-member-on-the-meeting-day",
  "proxy-holder-not-a-member",
  "proxy-holder-not-permitted-by-bylaws",
  "proxy-holder-limit-reached",
  "proxy-authority-not-yet-issued",
  "proxy-authority-expired",
  "proxy-authorisation-not-found",
  "attendance-not-found",
  "attendance-principal-not-applicable",
  "assistant-principal-not-present",
  "proxy-holder-holds-no-authority",
  "notice-already-issued",
  "meeting-has-no-agenda",
  "notice-time-not-on-the-meeting-day",
];

/** The five the server answers with a 403. */
const FORBIDDEN: readonly MeetingReason[] = [
  "not-a-member-on-the-meeting-day",
  "proxy-holder-not-a-member",
  "proxy-holder-not-permitted-by-bylaws",
  "proxy-holder-limit-reached",
  "proxy-holder-holds-no-authority",
];

describe("the meetings refusal map", () => {
  it("gives every reason a sentence of its own", () => {
    const keys = REASONS.map((reason) =>
      meetingFailureKey({ status: 409, reason }),
    );

    expect(keys).not.toContain("meetings.errors.unknown");
    // Distinct, because these send a board to different places: five things can
    // be wrong with one proxy authorisation and each has a different fix.
    expect(new Set(keys).size).toBe(REASONS.length);
  });

  it("names the rule rather than the status on the refusals that are 403s", () => {
    for (const reason of FORBIDDEN) {
      expect(meetingFailureKey({ status: 403, reason })).not.toBe(
        "settings.errors.forbidden",
      );
    }
  });

  it("still answers an account without the capability with the shared sentence", () => {
    // The guard's own refusal carries no reason this module knows, so it falls
    // through to the shared branch - which is exactly what it is for.
    expect(meetingFailureKey({ status: 403, reason: "forbidden" })).toBe(
      "settings.errors.forbidden",
    );
  });

  it("answers a request that never reached the server as such", () => {
    expect(meetingFailureKey({ status: 0, reason: "offline" })).toBe(
      "settings.errors.unknown",
    );
  });

  it("falls back for a reason it has never heard of", () => {
    expect(meetingFailureKey({ status: 409, reason: "something-new" })).toBe(
      "meetings.errors.unknown",
    );
  });
});
