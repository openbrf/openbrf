import { describe, expect, it } from "vite-plus/test";

import { stateOf } from "./import-proposal.service";

/**
 * Where a proposal stands, as its plugin and the board are told (ADR 0043):
 * read from the session, with the clock deciding expiry before the purge has
 * recorded it.
 */

const now = new Date("2026-10-22T12:00:00.000Z");
const later = new Date("2026-11-05T12:00:00.000Z");
const earlier = new Date("2026-10-20T12:00:00.000Z");
const decided = new Date("2026-10-21T09:00:00.000Z");
const finished = new Date("2026-10-21T09:05:00.000Z");

function row(
  overrides: Partial<Parameters<typeof stateOf>[0]>,
): Parameters<typeof stateOf>[0] {
  return {
    status: "MAPPING",
    proposalOutcome: null,
    expiresAt: later,
    decidedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe("stateOf", () => {
  it("reads a proposal in the mapping step as pending until it expires", () => {
    expect(stateOf(row({}), now)).toEqual({
      state: "pending",
      decidedAt: null,
    });
    expect(stateOf(row({ expiresAt: earlier }), now)).toEqual({
      state: "expired",
      decidedAt: earlier,
    });
  });

  it.each([
    ["REJECTED", "rejected"],
    ["SUPERSEDED", "superseded"],
    ["WITHDRAWN", "withdrawn"],
  ] as const)("reads %s as %s, when it was decided", (outcome, state) => {
    expect(
      stateOf(row({ proposalOutcome: outcome, decidedAt: decided }), now),
    ).toEqual({ state, decidedAt: decided });
  });

  it("dates an expired one by its expiry, not by the purge that recorded it", () => {
    expect(
      stateOf(
        row({ proposalOutcome: "EXPIRED", expiresAt: earlier, decidedAt: now }),
        now,
      ),
    ).toEqual({ state: "expired", decidedAt: earlier });
  });

  it("follows the import a board member started from it", () => {
    for (const status of ["QUEUED", "APPLYING"] as const) {
      expect(stateOf(row({ status, decidedAt: decided }), now)).toEqual({
        state: "applying",
        decidedAt: decided,
      });
    }
    expect(
      stateOf(
        row({ status: "APPLIED", decidedAt: decided, finishedAt: finished }),
        now,
      ),
    ).toEqual({ state: "applied", decidedAt: finished });
    expect(
      stateOf(
        row({ status: "FAILED", decidedAt: decided, finishedAt: finished }),
        now,
      ),
    ).toEqual({ state: "failed", decidedAt: finished });
  });

  it("does not read an import a board member started as expired", () => {
    // Its expiry was the proposal's, and the proposal is decided.
    expect(
      stateOf(
        row({ status: "APPLYING", expiresAt: earlier, decidedAt: decided }),
        now,
      ).state,
    ).toBe("applying");
  });
});
