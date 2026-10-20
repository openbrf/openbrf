import { type PluginManifest, pluginManifestSchema } from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  canonicalExtension,
  canonicalExtensionPoint,
  refuseExtensionTargets,
  widenedExtensions,
} from "./plugin-extension-gate";

/**
 * The extension gates that read manifests alone (ADR 0030), and so refuse an
 * addon before its code runs.
 */

function manifest(overrides: Record<string, unknown>): PluginManifest {
  return pluginManifestSchema.parse({
    apiVersion: 1,
    id: "example",
    entry: { server: "./dist/server.cjs" },
    ...overrides,
  });
}

const signage = manifest({
  id: "signage",
  personalData: ["name", "apartment"],
  extensionPoints: [{ id: "source", version: 2, personalData: ["name"] }],
});

function addon(extension: Record<string, unknown>): PluginManifest {
  return manifest({
    id: "signage-residents",
    personalData: ["name", "apartment"],
    extends: [{ plugin: "signage", point: "source", version: 2, ...extension }],
  });
}

describe("widenedExtensions", () => {
  it("lets through exactly what was consented to, in any order", () => {
    const host = manifest({
      personalData: ["name", "apartment"],
      extensionPoints: [
        { id: "source", version: 1, personalData: ["apartment", "name"] },
      ],
    });

    expect(
      widenedExtensions(host, {
        extensionPoints: ["source:1:apartment|name"],
        extends: [],
      }),
    ).toBeNull();
  });

  it("names a point that came to accept more", () => {
    // The id is unchanged; what it accepts is not, so it is a different point.
    expect(
      widenedExtensions(signage, {
        extensionPoints: ["source:2:"],
        extends: [],
      }),
    ).toEqual({ extensions: ["source"] });
  });

  it("names an extension at another version, or handing over more", () => {
    const residents = addon({ personalData: ["name"] });

    expect(
      widenedExtensions(residents, {
        extensionPoints: [],
        extends: ["signage:source:1:name"],
      }),
    ).toEqual({ extensions: ["signage/source"] });
    expect(
      widenedExtensions(residents, {
        extensionPoints: [],
        extends: ["signage:source:2:"],
      }),
    ).toEqual({ extensions: ["signage/source"] });
  });

  it("composes the strings the consent row stores", () => {
    expect(canonicalExtensionPoint(signage.extensionPoints[0]!)).toBe(
      "source:2:name",
    );
    expect(
      canonicalExtension(addon({ personalData: ["name"] }).extends[0]!),
    ).toBe("signage:source:2:name");
  });
});

describe("refuseExtensionTargets", () => {
  const hosts = new Map([["signage", signage]]);

  it("lets an addon serve beside a host that offers what it extends", () => {
    expect(
      refuseExtensionTargets(addon({ personalData: ["name"] }), hosts),
    ).toBeNull();
  });

  it("refuses an addon whose host plugin is not loaded", () => {
    expect(refuseExtensionTargets(addon({}), new Map())).toEqual({
      reason: "extension-host-missing",
      detail: { plugin: "signage" },
    });
  });

  it("refuses a point the host plugin does not declare", () => {
    expect(
      refuseExtensionTargets(
        manifest({
          extends: [{ plugin: "signage", point: "weather", version: 2 }],
        }),
        hosts,
      ),
    ).toEqual({
      reason: "extension-point-unknown",
      detail: { plugin: "signage", point: "weather" },
    });
  });

  it("refuses an addon written for another version of the point", () => {
    expect(refuseExtensionTargets(addon({ version: 1 }), hosts)).toEqual({
      reason: "extension-version-unsupported",
      detail: { plugin: "signage", point: "source", version: 1, supported: 2 },
    });
  });

  it("refuses an addon handing over what the point does not accept", () => {
    expect(
      refuseExtensionTargets(
        addon({ personalData: ["name", "apartment"] }),
        hosts,
      ),
    ).toEqual({
      reason: "extension-personal-data-refused",
      detail: { plugin: "signage", point: "source", categories: ["apartment"] },
    });
  });

  describe("beside a plugin that puts blocks on the website", () => {
    const website = manifest({
      id: "signage",
      permissions: ["site:blocks"],
      extensionPoints: [{ id: "source", version: 2 }],
    });
    const websiteHosts = new Map([["signage", website]]);

    function reader(permissions: string[]): PluginManifest {
      // It declares handing over nothing, which is all the point accepts.
      return manifest({
        id: "signage-residents",
        permissions,
        personalData: ["name", "apartment"],
        extends: [{ plugin: "signage", point: "source", version: 2 }],
      });
    }

    it("refuses an addon that reads the address book", () => {
      expect(
        refuseExtensionTargets(reader(["addressBook:read"]), websiteHosts),
      ).toEqual({
        reason: "extension-permission-refused",
        detail: {
          plugin: "signage",
          point: "source",
          permissions: ["addressBook:read"],
        },
      });
      expect(
        refuseExtensionTargets(
          reader(["addressBook:readContact", "mail:send"]),
          websiteHosts,
        ),
      ).toMatchObject({
        reason: "extension-permission-refused",
        detail: { permissions: ["addressBook:readContact"] },
      });
    });

    it("lets one serve that does not", () => {
      expect(
        refuseExtensionTargets(reader(["mail:send"]), websiteHosts),
      ).toBeNull();
    });

    it("lets an address-book reader extend a plugin with no blocks", () => {
      expect(
        refuseExtensionTargets(
          manifest({
            id: "signage-residents",
            permissions: ["addressBook:read"],
            personalData: ["name"],
            extends: [
              {
                plugin: "signage",
                point: "source",
                version: 2,
                personalData: ["name"],
              },
            ],
          }),
          hosts,
        ),
      ).toBeNull();
    });
  });

  describe("as a plugin that puts blocks on the website", () => {
    function readerHost(permissions: string[]): PluginManifest {
      return manifest({
        id: "signage",
        permissions,
        personalData: ["name", "apartment"],
        extensionPoints: [{ id: "source", version: 2 }],
      });
    }

    // It hands over nothing, but the point's input could carry names it
    // keeps and renders in a block.
    const website = manifest({
      id: "signage-website",
      permissions: ["site:blocks"],
      extends: [{ plugin: "signage", point: "source", version: 2 }],
    });

    it("refuses to extend a plugin that reads the address book", () => {
      expect(
        refuseExtensionTargets(
          website,
          new Map([["signage", readerHost(["addressBook:read"])]]),
        ),
      ).toEqual({
        reason: "extension-permission-refused",
        detail: {
          plugin: "signage",
          point: "source",
          permissions: ["addressBook:read"],
        },
      });
      expect(
        refuseExtensionTargets(
          website,
          new Map([
            ["signage", readerHost(["mail:send", "addressBook:readContact"])],
          ]),
        ),
      ).toMatchObject({
        reason: "extension-permission-refused",
        detail: { permissions: ["addressBook:readContact"] },
      });
    });

    it("lets it extend one that does not", () => {
      expect(
        refuseExtensionTargets(
          website,
          new Map([["signage", readerHost(["mail:send"])]]),
        ),
      ).toBeNull();
    });
  });
});
