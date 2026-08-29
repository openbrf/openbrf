import { describe, expect, it } from "vitest";

import {
  CONSENT_SCOPES,
  consentStateFor,
  consentViewOf,
  type PublicationConsentRecord,
} from "./publication-consent";

/**
 * What the board is shown about a person's publication consents.
 *
 * The projection carries the whole rule that withdrawal does not erase: a
 * scope can hold several dated facts, the most recent grant is the state that
 * holds, and the older ones stay behind as the record of what was lawful to
 * publish when.
 */

function consent(
  scope: PublicationConsentRecord["scope"],
  grantedAt: string,
  withdrawnAt: string | null = null,
  note: string | null = null,
): PublicationConsentRecord {
  return {
    scope,
    grantedAt: new Date(grantedAt),
    withdrawnAt: withdrawnAt === null ? null : new Date(withdrawnAt),
    note,
  };
}

describe("consentStateFor", () => {
  it("answers for every scope, including the ones nobody has asked about", () => {
    const state = consentStateFor([]);

    expect(state.map((view) => view.scope)).toEqual([...CONSENT_SCOPES]);
    expect(state.every((view) => view.state === "never")).toBe(true);
  });

  it("distinguishes a consent never given from one that was withdrawn", () => {
    const state = consentStateFor([
      consent("PHOTO", "2026-03-01T10:00:00Z", "2026-06-01T10:00:00Z"),
    ]);

    expect(state[0]).toEqual({
      scope: "PHOTO",
      state: "withdrawn",
      grantedOn: "2026-03-01",
      withdrawnOn: "2026-06-01",
      note: null,
    });
    expect(state[1]?.state).toBe("never");
  });

  it("reads the most recent grant, not the first one", () => {
    // Granted, withdrawn, granted again. The consent stands today, and the
    // earlier period is still on file.
    const state = consentStateFor([
      consent("NAME_ON_SITE", "2026-01-10T09:00:00Z", "2026-02-10T09:00:00Z"),
      consent("NAME_ON_SITE", "2026-07-01T09:00:00Z", null, "Sa ja på stämman"),
    ]);

    expect(state[1]).toEqual({
      scope: "NAME_ON_SITE",
      state: "granted",
      grantedOn: "2026-07-01",
      withdrawnOn: null,
      note: "Sa ja på stämman",
    });
  });

  it("keeps the scopes apart", () => {
    const state = consentStateFor([
      consent("PHOTO", "2026-01-10T09:00:00Z"),
      consent("BOARD_ROSTER", "2026-01-10T09:00:00Z", "2026-05-05T09:00:00Z"),
    ]);

    expect(state.map((view) => view.state)).toEqual([
      "granted",
      "never",
      "withdrawn",
    ]);
  });

  it("does not let the order rows arrive in decide the answer", () => {
    const older = consent(
      "PHOTO",
      "2026-01-10T09:00:00Z",
      "2026-02-10T09:00:00Z",
    );
    const newer = consent("PHOTO", "2026-07-01T09:00:00Z");

    expect(consentStateFor([older, newer])[0]).toEqual(
      consentStateFor([newer, older])[0],
    );
  });
});

describe("consentViewOf", () => {
  it("reports the dates as days, like every other register date", () => {
    expect(
      consentViewOf(
        "BOARD_ROSTER",
        consent("BOARD_ROSTER", "2026-04-15T22:30:00Z", "2026-09-01T05:00:00Z"),
      ),
    ).toEqual({
      scope: "BOARD_ROSTER",
      state: "withdrawn",
      grantedOn: "2026-04-15",
      withdrawnOn: "2026-09-01",
      note: null,
    });
  });
});
