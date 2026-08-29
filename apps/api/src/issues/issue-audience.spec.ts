import { describe, expect, it } from "vitest";

import type { Capability, Principal } from "../authorization/capabilities";
import { reportableAudiences } from "./issue-audience";

/**
 * The audience rule, which decides what a person is even offered.
 *
 * It is asserted here rather than only through HTTP because it is the whole of
 * the promise the module makes: a member picks from the member types, a
 * non-member from the non-member ones, and the board's internal categories are
 * shown to nobody who does not handle issues.
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

describe("reportableAudiences", () => {
  it("offers a caller with no session the non-member types only", () => {
    expect(reportableAudiences(null)).toEqual(["NON_MEMBER"]);
  });

  it("offers a resident the member types, and not the board's", () => {
    expect(
      reportableAudiences(
        principal({ isResident: true, capabilities: ["issues:report"] }),
      ),
    ).toEqual(["MEMBER"]);
  });

  it("treats a tenant the same as a tenant-owner", () => {
    // The audience names who is reporting, not who holds the apartment: a
    // partner reports the same broken lift.
    expect(
      reportableAudiences(principal({ isResident: true, isMember: false })),
    ).toEqual(
      reportableAudiences(principal({ isResident: true, isMember: true })),
    );
  });

  it("treats a signed-in person who does not live here as a non-member", () => {
    expect(reportableAudiences(principal({}))).toEqual(["NON_MEMBER"]);
  });

  it("adds the internal types for whoever handles issues", () => {
    expect(
      reportableAudiences(
        principal({ isResident: true, capabilities: ["issues:handle"] }),
      ),
    ).toEqual(["MEMBER", "BOARD"]);
  });

  it("never offers the internal types to a reporter who cannot handle them", () => {
    for (const viewer of [
      null,
      principal({ isResident: true, capabilities: ["issues:report"] }),
      principal({ capabilities: ["issues:configure"] }),
    ]) {
      expect(reportableAudiences(viewer)).not.toContain("BOARD");
    }
  });
});
