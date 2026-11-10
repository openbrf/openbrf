import { describe, expect, it } from "vite-plus/test";

import type { Capability, Principal } from "../authorization/capabilities";
import { reporterGroupsOf } from "./issue-reporter-groups";

/**
 * The reporter rule, which decides what a person is even offered.
 *
 * It is asserted here rather than only through HTTP because it is the whole of
 * the promise the module makes: a resident picks from the types residents may
 * report, everybody else from the ones the public may, and the board's internal
 * categories are shown to nobody who does not handle issues.
 */

function principal(input: {
  isResident?: boolean;
  isMember?: boolean;
  capabilities?: readonly Capability[];
}): Principal {
  return {
    personId: "person-1",
    isAdmin: false,
    isBoardMember: false,
    isPropertyManager: false,
    isResident: input.isResident ?? false,
    isMember: input.isMember ?? false,
    capabilities: new Set(input.capabilities ?? []),
  };
}

describe("reporterGroupsOf", () => {
  it("offers a caller with no session the public types only", () => {
    expect(reporterGroupsOf(null)).toEqual(["PUBLIC"]);
  });

  it("offers a resident the residents' types, and not the board's", () => {
    expect(
      reporterGroupsOf(
        principal({ isResident: true, capabilities: ["issues:report"] }),
      ),
    ).toEqual(["RESIDENTS"]);
  });

  it("treats a tenant the same as a tenant-owner", () => {
    // The group names who is reporting, not who holds the apartment: a
    // partner reports the same broken lift.
    expect(
      reporterGroupsOf(principal({ isResident: true, isMember: false })),
    ).toEqual(
      reporterGroupsOf(principal({ isResident: true, isMember: true })),
    );
  });

  it("treats a signed-in person who does not live here as the public", () => {
    expect(reporterGroupsOf(principal({}))).toEqual(["PUBLIC"]);
  });

  it("adds the internal types for whoever handles issues", () => {
    expect(
      reporterGroupsOf(
        principal({ isResident: true, capabilities: ["issues:handle"] }),
      ),
    ).toEqual(["RESIDENTS", "HANDLERS"]);
  });

  it("never offers the internal types to a reporter who cannot handle them", () => {
    for (const viewer of [
      null,
      principal({ isResident: true, capabilities: ["issues:report"] }),
      principal({ capabilities: ["issues:configure"] }),
    ]) {
      expect(reporterGroupsOf(viewer)).not.toContain("HANDLERS");
    }
  });
});
