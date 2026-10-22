import type { PluginLicenceDeclaration } from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vite-plus/test";

import { licenceWidening } from "./plugin-licence-gate";

/**
 * A republished plugin cannot add a service it presents the association's
 * licence to without the board's consent (ADR 0042).
 */

const GATEWAY = "https://gateway.example.org";
const THEMES = "https://themes.example.org";

function declared(
  overrides: Partial<PluginLicenceDeclaration> = {},
): PluginLicenceDeclaration {
  return {
    entitlement: "mcp-connector",
    issuer: { name: "Example AB", url: "https://licence.example.org" },
    keys: { "example-2026-1": `${"A".repeat(42)}A=` },
    audiences: [GATEWAY],
    ...overrides,
  };
}

describe("licenceWidening", () => {
  it("passes a plugin that reads no licence, whatever was consented", () => {
    expect(licenceWidening(undefined, null)).toBeNull();
    expect(
      licenceWidening(undefined, {
        entitlement: "mcp-connector",
        audiences: [GATEWAY],
      }),
    ).toBeNull();
  });

  it("passes the declaration the board consented to", () => {
    expect(
      licenceWidening(declared(), {
        entitlement: "mcp-connector",
        audiences: [GATEWAY],
      }),
    ).toBeNull();
  });

  it("passes fewer audiences than were consented", () => {
    expect(
      licenceWidening(declared({ audiences: [] }), {
        entitlement: "mcp-connector",
        audiences: [GATEWAY, THEMES],
      }),
    ).toBeNull();
  });

  it("lists an audience the board was not told of", () => {
    expect(
      licenceWidening(declared({ audiences: [GATEWAY, THEMES] }), {
        entitlement: "mcp-connector",
        audiences: [GATEWAY],
      }),
    ).toEqual({ audiences: [THEMES] });
  });

  it("refuses a licence on a plugin consented to as reading none", () => {
    expect(licenceWidening(declared(), null)).toEqual({
      audiences: [GATEWAY],
    });
    // Even with no audience: the board was never told the plugin needs a
    // licence and does nothing without one.
    expect(licenceWidening(declared({ audiences: [] }), null)).toEqual({
      audiences: [],
    });
  });

  it("refuses another entitlement, with every audience it names", () => {
    expect(
      licenceWidening(declared({ entitlement: "ai-package" }), {
        entitlement: "mcp-connector",
        audiences: [GATEWAY],
      }),
    ).toEqual({ audiences: [GATEWAY] });
  });

  it("does not compare the issuer's keys, which a rotation changes", () => {
    expect(
      licenceWidening(
        declared({ keys: { "example-2027-1": `${"B".repeat(42)}A=` } }),
        { entitlement: "mcp-connector", audiences: [GATEWAY] },
      ),
    ).toBeNull();
  });
});
