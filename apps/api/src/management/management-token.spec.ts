import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashOpaqueToken, tokensMatch } from "../auth/opaque-token";
import {
  matchingManagementDigest,
  presentedManagementToken,
} from "./management-token";

vi.mock("../auth/opaque-token", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../auth/opaque-token")>();
  return { ...original, tokensMatch: vi.fn(original.tokensMatch) };
});

/**
 * The management API's credential (ADR 0021).
 *
 * The token is the whole of what stands between the listener and the counts it
 * answers with, so the assertions are about what is taken as a token at all,
 * which digests it may match, and that the comparison is the constant-time one
 * every other held digest is compared with.
 */

/** The token the host holds now, and the one it is rotating away from. */
const CURRENT = "management-token-current-0000000000000000001";
const PREVIOUS = "management-token-previous-000000000000000002";
const DIGESTS = [hashOpaqueToken(CURRENT), hashOpaqueToken(PREVIOUS)];

/** Raw headers as Node keeps them: name, value, name, value. */
function raw(...pairs: [string, string][]): string[] {
  return pairs.flat();
}

/** The whole check, as the listener makes it. */
function accepted(rawHeaders: readonly string[], digests = DIGESTS) {
  const token = presentedManagementToken(rawHeaders);
  return token === null ? null : matchingManagementDigest(token, digests);
}

beforeEach(() => {
  vi.mocked(tokensMatch).mockClear();
});

describe("which token a request presents", () => {
  it("is the credential after the Bearer scheme", () => {
    expect(
      presentedManagementToken(
        raw(["Host", "app:3001"], ["Authorization", `Bearer ${CURRENT}`]),
      ),
    ).toBe(CURRENT);
  });

  it("takes the scheme in any case, as RFC 9110 has it", () => {
    expect(
      presentedManagementToken(raw(["authorization", `bearer ${CURRENT}`])),
    ).toBe(CURRENT);
  });

  it("is none when the header is missing", () => {
    expect(presentedManagementToken(raw(["Host", "app:3001"]))).toBeNull();
  });

  it("is none when the header is sent twice, whichever comes first", () => {
    // Node's parsed headers would keep the first and drop the second, so a
    // right token followed by anything would pass. Two is ambiguous, and
    // ambiguous is refused.
    expect(
      presentedManagementToken(
        raw(
          ["Authorization", `Bearer ${CURRENT}`],
          ["authorization", "Bearer something-else"],
        ),
      ),
    ).toBeNull();
    expect(
      presentedManagementToken(
        raw(
          ["authorization", "Bearer something-else"],
          ["Authorization", `Bearer ${CURRENT}`],
        ),
      ),
    ).toBeNull();
  });

  it("is none for another scheme or an empty credential", () => {
    for (const value of [
      `Basic ${CURRENT}`,
      CURRENT,
      "Bearer",
      "Bearer    ",
      `Bearer${CURRENT}`,
    ]) {
      expect(
        presentedManagementToken(raw(["Authorization", value])),
        value,
      ).toBeNull();
    }
  });
});

describe("which configured digest a token matches", () => {
  it("accepts the current token and the one being rotated away from", () => {
    expect(accepted(raw(["Authorization", `Bearer ${CURRENT}`]))).toBe(0);
    expect(accepted(raw(["Authorization", `Bearer ${PREVIOUS}`]))).toBe(1);
  });

  it("accepts one digest alone", () => {
    expect(
      accepted(raw(["Authorization", `Bearer ${CURRENT}`]), [DIGESTS[0]!]),
    ).toBe(0);
  });

  it("refuses a wrong token", () => {
    expect(
      accepted(raw(["Authorization", "Bearer not-the-management-token"])),
    ).toBeNull();
  });

  it("refuses the digest itself presented as the token", () => {
    // What a leaked environment holds. It is worth nothing as a credential.
    expect(
      accepted(raw(["Authorization", `Bearer ${DIGESTS[0]!}`])),
    ).toBeNull();
  });

  it("refuses a lower-case scheme with a wrong credential", () => {
    expect(
      accepted(raw(["authorization", "bearer not-the-management-token"])),
    ).toBeNull();
  });

  it("refuses a missing header and a second header", () => {
    expect(accepted(raw(["Host", "app:3001"]))).toBeNull();
    expect(
      accepted(
        raw(
          ["Authorization", `Bearer ${CURRENT}`],
          ["Authorization", `Bearer ${CURRENT}`],
        ),
      ),
    ).toBeNull();
  });

  it("refuses everything when no digest is configured", () => {
    expect(
      accepted(raw(["Authorization", `Bearer ${CURRENT}`]), []),
    ).toBeNull();
  });

  it("compares in constant time, against every digest", () => {
    matchingManagementDigest(CURRENT, DIGESTS);

    // The constant-time comparison every held digest goes through, and both
    // digests even though the first already matched: stopping early would let
    // the time taken say which of the two a token is.
    expect(vi.mocked(tokensMatch).mock.calls).toEqual([
      [DIGESTS[0], DIGESTS[0]],
      [DIGESTS[0], DIGESTS[1]],
    ]);
  });
});
