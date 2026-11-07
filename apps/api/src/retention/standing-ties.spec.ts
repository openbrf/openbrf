import { describe, expect, it } from "vite-plus/test";

import { purgeRefusal } from "./purge-refusal";
import { holdsNoStandingTie, standingTie } from "./standing-ties";

const NOW = new Date("2027-06-01T12:00:00Z");

const NONE = { boardPositions: [], systemRoles: [], pluginAccesses: [] };

describe("what keeps a person", () => {
  it("keeps nobody who holds nothing", () => {
    expect(standingTie(NONE, NOW)).toBeNull();
  });

  it("keeps a person while a board seat has not ended", () => {
    expect(
      standingTie({ ...NONE, boardPositions: [{ endedOn: null }] }, NOW),
    ).toBe("board-position-current");
    expect(
      standingTie(
        { ...NONE, boardPositions: [{ endedOn: new Date(NOW.getTime() + 1) }] },
        NOW,
      ),
    ).toBe("board-position-current");
  });

  it("lets a seat go at the instant it ends, as the query does", () => {
    // The query keeps a seat whose end is after now, so one ending at now is
    // over in both forms.
    expect(
      standingTie({ ...NONE, boardPositions: [{ endedOn: NOW }] }, NOW),
    ).toBeNull();
    expect(holdsNoStandingTie(NOW)).toEqual({
      boardPositions: {
        none: { OR: [{ endedOn: null }, { endedOn: { gt: NOW } }] },
      },
      systemRoles: { none: {} },
      pluginAccesses: { none: {} },
    });
  });

  it("keeps a person who holds a system role", () => {
    expect(
      standingTie({ ...NONE, systemRoles: [{ role: "ADMIN" }] }, NOW),
    ).toBe("system-role-current");
  });

  it("keeps a person who holds a plugin access, and lets them go once it is withdrawn", () => {
    // A plugin access is only ever held by somebody who never lived here
    // (ADR 0053), so it is the one thing that keeps such a person.
    expect(
      standingTie({ ...NONE, pluginAccesses: [{ id: "access" }] }, NOW),
    ).toBe("plugin-access-current");
    expect(standingTie({ ...NONE, pluginAccesses: [] }, NOW)).toBeNull();
  });

  it("is what the purge refuses a person for, after a hold", () => {
    const facts = {
      residencies: [{ movedOutOn: new Date("2015-01-31") }],
      boardPositions: [{ endedOn: null }],
      systemRoles: [],
      pluginAccesses: [],
      legalHolds: [],
      processingRestrictedAt: null,
    };
    expect(purgeRefusal(facts, NOW, NOW, true)).toBe("board-position-current");
    expect(
      purgeRefusal({ ...facts, legalHolds: [{ id: "hold" }] }, NOW, NOW, true),
    ).toBe("on-legal-hold");
  });
});
