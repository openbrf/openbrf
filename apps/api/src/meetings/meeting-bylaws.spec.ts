import { describe, expect, it } from "vitest";

import {
  isWritableProxyLimit,
  MAX_MEMBERS_PER_PROXY_HOLDER,
  readMeetingBylaws,
  statutoryMeetingBylaws,
} from "./meeting-bylaws";

/**
 * The four bylaws clauses BRL 9 kap. 14 § leaves to the association.
 *
 * The assertion this file exists for is the default proxy limit. EFL 6 kap. 5 §
 * lets an ombud represent three members in an economic association generally,
 * and BRL 9 kap. 14 § 4 replaces that with one for a housing cooperative unless
 * the bylaws determine otherwise. An instance carrying the general rule would let
 * one person arrive holding a block of votes the statute keeps out of a
 * bostadsrattsforening, and it would do so without anything looking wrong.
 */

const STORED = {
  bylawsWidenProxyHolderEligibility: true,
  bylawsMaxMembersPerProxyHolder: 3,
  bylawsLimitStorageOnlyVote: true,
  bylawsWidenAssistantEligibility: true,
};

describe("reading the clauses", () => {
  it("reads all four columns as the clauses they stand for", () => {
    expect(readMeetingBylaws(STORED)).toEqual({
      proxyHolderEligibilityWidened: true,
      maxMembersPerProxyHolder: 3,
      storageOnlyVoteLimited: true,
      assistantEligibilityWidened: true,
    });
  });

  it("puts an instance with no association row under the statute", () => {
    // Not "unconfigured": every clause here has a rule that applies unless the
    // bylaws displace it, so a cooperative whose bylaws nobody has recorded is
    // governed by the statute rather than by nothing.
    expect(statutoryMeetingBylaws()).toEqual({
      proxyHolderEligibilityWidened: false,
      maxMembersPerProxyHolder: 1,
      storageOnlyVoteLimited: false,
      assistantEligibilityWidened: false,
    });
  });

  it("puts the statutory proxy limit at one and not at three", () => {
    /*
     * The load-bearing assertion of this file. BRL 9 kap. 14 § 4 has nobody
     * represent more than one member as ombud unless the bylaws determine
     * otherwise, replacing EFL 6 kap. 5 §'s three - and three is exactly the
     * value an implementation reading the general Act would arrive at.
     */
    expect(statutoryMeetingBylaws().maxMembersPerProxyHolder).toBe(1);
  });
});

describe("what a bylaws clause could name", () => {
  it("accepts a whole number of members from one upwards", () => {
    expect(isWritableProxyLimit(1)).toBe(true);
    expect(isWritableProxyLimit(3)).toBe(true);
    expect(isWritableProxyLimit(MAX_MEMBERS_PER_PROXY_HOLDER)).toBe(true);
  });

  it("refuses a limit of zero, which would refuse what the statute permits", () => {
    // EFL 6 kap. 4 § gives a member who is not personally present the right to
    // act through an ombud. A limit of zero is not a strict association: it is a
    // setting that refuses a right the bylaws cannot take away.
    expect(isWritableProxyLimit(0)).toBe(false);
    expect(isWritableProxyLimit(-1)).toBe(false);
  });

  it("refuses a fraction and a figure past the bound", () => {
    // A clause names a whole number of members, and a four-digit one is a
    // keystroke rather than a limit anybody is applying.
    expect(isWritableProxyLimit(1.5)).toBe(false);
    expect(isWritableProxyLimit(MAX_MEMBERS_PER_PROXY_HOLDER + 1)).toBe(false);
    expect(isWritableProxyLimit(Number.NaN)).toBe(false);
  });
});
