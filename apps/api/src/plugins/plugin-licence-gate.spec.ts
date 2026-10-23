import { createHash } from "node:crypto";

import type { PluginLicenceDeclaration } from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vite-plus/test";

import { licenceKeyFingerprints } from "../licences/entitlement-judgement";
import { keysRefused, licenceRefusal } from "./plugin-licence-gate";
import type { ConsentedLicence } from "./plugin-registry.service";

/**
 * A republished plugin cannot add a service it presents the association's
 * licence to, nor a key whose licences it reads, without the board's consent
 * (ADR 0042).
 */

const GATEWAY = "https://gateway.example.org";
const THEMES = "https://themes.example.org";
const ISSUER = { name: "Example AB", url: "https://licence.example.org" };
/** Three keys, each the padded base64 of 32 bytes. */
const KEY_2026 = `${"A".repeat(42)}A=`;
const KEY_2027 = `${"B".repeat(42)}A=`;
const OTHER_KEY = `${"C".repeat(42)}A=`;

function fingerprint(encoded: string): string {
  return createHash("sha256")
    .update(Buffer.from(encoded, "base64"))
    .digest("hex");
}

function declared(
  overrides: Partial<PluginLicenceDeclaration> = {},
): PluginLicenceDeclaration {
  return {
    entitlement: "mcp-connector",
    issuer: ISSUER,
    keys: { "example-2026-1": KEY_2026 },
    audiences: [GATEWAY],
    ...overrides,
  };
}

function consented(
  overrides: Partial<ConsentedLicence> = {},
): ConsentedLicence {
  return {
    entitlement: "mcp-connector",
    audiences: [GATEWAY],
    issuer: ISSUER,
    keys: [fingerprint(KEY_2026)],
    ...overrides,
  };
}

describe("licenceRefusal", () => {
  it("passes a plugin that reads no licence, whatever was consented", () => {
    expect(licenceRefusal(undefined, null)).toBeNull();
    expect(licenceRefusal(undefined, consented())).toBeNull();
  });

  it("passes the declaration the board consented to", () => {
    expect(licenceRefusal(declared(), consented())).toBeNull();
  });

  it("passes fewer audiences than were consented", () => {
    expect(
      licenceRefusal(
        declared({ audiences: [] }),
        consented({ audiences: [GATEWAY, THEMES] }),
      ),
    ).toBeNull();
  });

  it("lists an audience the board was not told of", () => {
    expect(
      licenceRefusal(declared({ audiences: [GATEWAY, THEMES] }), consented()),
    ).toEqual({
      reason: "licence-widened",
      detail: { audiences: [THEMES], keys: [] },
    });
  });

  it("refuses a licence on a plugin consented to as reading none", () => {
    expect(licenceRefusal(declared(), null)).toEqual({
      reason: "licence-widened",
      detail: { audiences: [GATEWAY], keys: ["example-2026-1"] },
    });
    // Even with no audience: the board was never told the plugin needs a
    // licence and does nothing without one.
    expect(licenceRefusal(declared({ audiences: [] }), null)).toEqual({
      reason: "licence-widened",
      detail: { audiences: [], keys: ["example-2026-1"] },
    });
  });

  it("refuses another entitlement, with every audience and key it names", () => {
    expect(
      licenceRefusal(declared({ entitlement: "ai-package" }), consented()),
    ).toEqual({
      reason: "licence-widened",
      detail: { audiences: [GATEWAY], keys: ["example-2026-1"] },
    });
  });

  describe("the issuer's keys", () => {
    it("passes the consented keys under other key ids", () => {
      // A licence is judged by the key's fingerprint, not by its id.
      expect(
        licenceRefusal(
          declared({ keys: { "renamed-1": KEY_2026 } }),
          consented(),
        ),
      ).toBeNull();
    });

    it("passes both keys of a rotation the board consented to", () => {
      expect(
        licenceRefusal(
          declared({
            keys: { "example-2026-1": KEY_2026, "example-2027-1": KEY_2027 },
          }),
          consented({ keys: [fingerprint(KEY_2027), fingerprint(KEY_2026)] }),
        ),
      ).toBeNull();
    });

    it("needs consent to a key added beside the consented one", () => {
      // The first half of a rotation (ADR 0042): a new key declared before
      // any licence is signed with it. The board consents to it as it does
      // to the update that brings it, and until then the plugin is not loaded.
      expect(
        licenceRefusal(
          declared({
            keys: { "example-2026-1": KEY_2026, "example-2027-1": KEY_2027 },
          }),
          consented(),
        ),
      ).toEqual({
        reason: "licence-widened",
        detail: { audiences: [], keys: ["example-2027-1"] },
      });
    });

    it("refuses a key swapped for the consented one, under its key id", () => {
      // What a tarball that disagrees with its catalog entry looks like: the
      // same issuer and key id, another issuer's key, whose licences the
      // plugin would read for the same entitlement.
      expect(
        licenceRefusal(
          declared({ keys: { "example-2026-1": OTHER_KEY } }),
          consented(),
        ),
      ).toEqual({
        reason: "licence-issuer-changed",
        detail: { audiences: [], keys: ["example-2026-1"] },
      });
    });

    it("refuses a consented key dropped, though the rest were consented", () => {
      expect(
        licenceRefusal(
          declared({ keys: { "example-2027-1": KEY_2027 } }),
          consented({ keys: [fingerprint(KEY_2026), fingerprint(KEY_2027)] }),
        ),
      ).toEqual({
        reason: "licence-issuer-changed",
        detail: { audiences: [], keys: [] },
      });
    });

    it.each([
      ["name", { ...ISSUER, name: "Other AB" }],
      ["address", { ...ISSUER, url: "https://licence.other.example.org" }],
    ])(
      "refuses another issuer %s with the consented keys",
      (_field, issuer) => {
        expect(licenceRefusal(declared({ issuer }), consented())).toEqual({
          reason: "licence-issuer-changed",
          detail: { audiences: [], keys: [] },
        });
      },
    );

    it("lists the audiences and keys beside an issuer that changed", () => {
      expect(
        licenceRefusal(
          declared({
            keys: { "other-2026-1": OTHER_KEY },
            audiences: [GATEWAY, THEMES],
          }),
          consented(),
        ),
      ).toEqual({
        reason: "licence-issuer-changed",
        detail: { audiences: [THEMES], keys: ["other-2026-1"] },
      });
    });
  });
});

describe("keysRefused", () => {
  it("leaves a refusal over audiences alone to the boot's licence read", () => {
    const refusal = licenceRefusal(
      declared({ audiences: [GATEWAY, THEMES] }),
      consented(),
    );
    expect(refusal).not.toBeNull();
    expect(keysRefused(refusal!, consented())).toBe(false);
  });

  it("holds a refusal over a key", () => {
    const refusal = licenceRefusal(
      declared({ keys: { "example-2026-1": KEY_2026, "other-1": OTHER_KEY } }),
      consented(),
    );
    expect(keysRefused(refusal!, consented())).toBe(true);
  });

  it("holds a refusal over the issuer", () => {
    const refusal = licenceRefusal(
      declared({ issuer: { ...ISSUER, name: "Other AB" } }),
      consented(),
    );
    expect(keysRefused(refusal!, consented())).toBe(true);
  });

  it("holds any refusal where no licence was consented to", () => {
    const refusal = licenceRefusal(declared({ keys: {} }), null);
    expect(refusal).not.toBeNull();
    expect(keysRefused(refusal!, null)).toBe(true);
  });
});

describe("licenceKeyFingerprints", () => {
  it("takes the SHA-256 of each key's bytes, as a licence is judged by", () => {
    expect(
      licenceKeyFingerprints(
        declared({
          keys: { "example-2026-1": KEY_2026, "example-2027-1": KEY_2027 },
        }),
      ),
    ).toEqual([fingerprint(KEY_2026), fingerprint(KEY_2027)]);
  });
});
