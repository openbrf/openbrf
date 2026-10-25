import { type PluginManifest, pluginManifestSchema } from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  canonicalExtension,
  canonicalExtensionPoint,
  refuseExtensionGroups,
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

// What a plugin that proposes an import must declare it carries.
const memberList = [
  "name",
  "apartment",
  "residency",
  "email",
  "phone",
  "personalIdentityNumber",
  "protected",
];

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

    function reader(
      permissions: string[],
      personalData: string[] = ["name", "apartment"],
    ): PluginManifest {
      // It declares handing over nothing, which is all the point accepts.
      return manifest({
        id: "signage-residents",
        permissions,
        personalData,
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

    it("refuses an addon that proposes imports", () => {
      // It reads nothing in the register, but holds the member list it
      // proposes.
      expect(
        refuseExtensionTargets(
          reader(["addressBook:proposeImport"], memberList),
          websiteHosts,
        ),
      ).toEqual({
        reason: "extension-permission-refused",
        detail: {
          plugin: "signage",
          point: "source",
          permissions: ["addressBook:proposeImport"],
        },
      });
    });

    it("lets one serve that does not", () => {
      expect(
        refuseExtensionTargets(reader(["mail:send"]), websiteHosts),
      ).toBeNull();
    });

    it("lets a proposer extend a plugin with no blocks", () => {
      expect(
        refuseExtensionTargets(
          reader(["addressBook:proposeImport"], memberList),
          new Map([
            [
              "signage",
              manifest({
                id: "signage",
                permissions: ["mail:send"],
                extensionPoints: [{ id: "source", version: 2 }],
              }),
            ],
          ]),
        ),
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
    function readerHost(
      permissions: string[],
      personalData: string[] = ["name", "apartment"],
    ): PluginManifest {
      return manifest({
        id: "signage",
        permissions,
        personalData,
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

    it("refuses to extend a plugin that proposes imports", () => {
      expect(
        refuseExtensionTargets(
          website,
          new Map([
            ["signage", readerHost(["addressBook:proposeImport"], memberList)],
          ]),
        ),
      ).toEqual({
        reason: "extension-permission-refused",
        detail: {
          plugin: "signage",
          point: "source",
          permissions: ["addressBook:proposeImport"],
        },
      });
    });

    it("refuses to extend a plugin that handles personal data", () => {
      // Another addon could hand it names, and it could hand them on as the
      // point's input.
      expect(
        refuseExtensionTargets(
          website,
          new Map([["signage", readerHost(["mail:send"], ["name"])]]),
        ),
      ).toEqual({
        reason: "extension-host-personal-data-refused",
        detail: { plugin: "signage", point: "source", categories: ["name"] },
      });
    });

    it("lets it extend one that does neither", () => {
      expect(
        refuseExtensionTargets(
          website,
          new Map([["signage", readerHost(["mail:send"], [])]]),
        ),
      ).toBeNull();
    });
  });
});

describe("refuseExtensionGroups", () => {
  // A host plugin that reads nothing and handles nothing, which each addon
  // below passes `refuseExtensionTargets` against.
  const signage = manifest({
    id: "signage",
    extensionPoints: [
      { id: "source", version: 1 },
      { id: "display", version: 1 },
    ],
  });
  const calendar = manifest({
    id: "calendar",
    extensionPoints: [{ id: "feed", version: 1 }],
  });

  function extending(
    id: string,
    permissions: string[],
    targets: [plugin: string, point: string][],
  ): PluginManifest {
    return manifest({
      id,
      permissions,
      extends: targets.map(([plugin, point]) => ({
        plugin,
        point,
        version: 1,
      })),
    });
  }

  // It says it hands over nothing, which only its own manifest says.
  const residents = extending(
    "signage-residents",
    ["addressBook:read"],
    [["signage", "source"]],
  );
  const website = extending(
    "signage-website",
    ["site:blocks"],
    [["signage", "display"]],
  );

  it("refuses a website addon beside one that reads the address book, in either order", () => {
    for (const addons of [
      [residents, website],
      [website, residents],
    ]) {
      expect(refuseExtensionGroups([signage], addons)).toEqual(
        new Map([
          [
            "signage-website",
            {
              reason: "extension-group-refused",
              detail: {
                website: ["signage-website"],
                register: ["signage-residents"],
              },
            },
          ],
        ]),
      );
    }
  });

  describe("through an addon that extends two host plugins", () => {
    const bridge = extending(
      "bridge",
      [],
      [
        ["signage", "source"],
        ["calendar", "feed"],
      ],
    );
    const calendarWebsite = extending(
      "calendar-website",
      ["site:blocks"],
      [["calendar", "feed"]],
    );

    it("refuses that addon, and lets each host plugin's own addons serve", () => {
      for (const addons of [
        [calendarWebsite, bridge, residents],
        [residents, bridge, calendarWebsite],
      ]) {
        expect(
          refuseExtensionGroups([calendar, signage], addons).get("bridge"),
        ).toEqual({
          reason: "extension-group-refused",
          detail: {
            website: ["calendar-website"],
            register: ["signage-residents"],
          },
        });
        expect(refuseExtensionGroups([calendar, signage], addons).size).toBe(1);
      }
    });

    it("refuses a website addon beside the reader first, and the bridge only while both kinds remain", () => {
      expect(
        refuseExtensionGroups(
          [calendar, signage],
          [calendarWebsite, bridge, residents, website],
        ),
      ).toEqual(
        new Map([
          [
            "signage-website",
            {
              reason: "extension-group-refused",
              detail: {
                website: ["signage-website"],
                register: ["signage-residents"],
              },
            },
          ],
          [
            "bridge",
            {
              reason: "extension-group-refused",
              detail: {
                website: ["calendar-website"],
                register: ["signage-residents"],
              },
            },
          ],
        ]),
      );
      expect([
        ...refuseExtensionGroups(
          [calendar, signage],
          [bridge, residents, website],
        ).keys(),
      ]).toEqual(["signage-website"]);
    });
  });

  it("refuses the addon that joins a website host plugin to one that reads the address book", () => {
    const websiteHost = manifest({
      id: "noticeboard",
      permissions: ["site:blocks"],
      extensionPoints: [{ id: "notice", version: 1 }],
    });
    const readerHost = manifest({
      id: "directory",
      permissions: ["addressBook:read"],
      personalData: ["name"],
      extensionPoints: [{ id: "entry", version: 1 }],
    });
    const bridge = extending(
      "bridge",
      [],
      [
        ["noticeboard", "notice"],
        ["directory", "entry"],
      ],
    );
    const weather = extending("weather", [], [["noticeboard", "notice"]]);

    expect(
      refuseExtensionGroups([readerHost, websiteHost], [weather, bridge]),
    ).toEqual(
      new Map([
        [
          "bridge",
          {
            reason: "extension-group-refused",
            detail: { website: ["noticeboard"], register: ["directory"] },
          },
        ],
      ]),
    );

    // Each host plugin's own addon is of its kind, so each star is clean, and
    // installing the bridge switches off only the bridge.
    const notices = extending(
      "notices",
      ["site:blocks"],
      [["noticeboard", "notice"]],
    );
    const entries = extending(
      "entries",
      ["addressBook:read"],
      [["directory", "entry"]],
    );
    for (const addons of [
      [notices, entries, bridge],
      [bridge, entries, notices],
    ]) {
      expect(refuseExtensionGroups([readerHost, websiteHost], addons)).toEqual(
        new Map([
          [
            "bridge",
            {
              reason: "extension-group-refused",
              detail: {
                website: ["noticeboard", "notices"],
                register: ["directory", "entries"],
              },
            },
          ],
        ]),
      );
    }
    expect(
      refuseExtensionGroups([readerHost, websiteHost], [notices, entries]).size,
    ).toBe(0);
  });

  it("refuses a website addon beside one that proposes imports", () => {
    // It reads nothing in the register, but the member list it holds can
    // reach the host plugin as a name while it declares handing over none.
    const proposer = manifest({
      id: "signage-import",
      permissions: ["addressBook:proposeImport"],
      personalData: memberList,
      extends: [{ plugin: "signage", point: "source", version: 1 }],
    });

    for (const addons of [
      [proposer, website],
      [website, proposer],
    ]) {
      expect(refuseExtensionGroups([signage], addons)).toEqual(
        new Map([
          [
            "signage-website",
            {
              reason: "extension-group-refused",
              detail: {
                website: ["signage-website"],
                register: ["signage-import"],
              },
            },
          ],
        ]),
      );
    }
    expect(refuseExtensionGroups([signage], [proposer]).size).toBe(0);
  });

  it("refuses a website addon beside one that only declares names", () => {
    // No permission, but an action such as `motion_queue_list` may hand it
    // names while a board member uses its route, and the manifest says so.
    const motions = manifest({
      id: "signage-motions",
      personalData: ["name"],
      extends: [{ plugin: "signage", point: "source", version: 1 }],
    });

    expect(refuseExtensionGroups([signage], [motions, website])).toEqual(
      new Map([
        [
          "signage-website",
          {
            reason: "extension-group-refused",
            detail: {
              website: ["signage-website"],
              register: ["signage-motions"],
            },
          },
        ],
      ]),
    );
  });

  it("lets a group serve that holds only one of the two", () => {
    const weather = extending(
      "weather",
      ["mail:send"],
      [["signage", "source"]],
    );

    expect(refuseExtensionGroups([signage], [residents, weather]).size).toBe(0);
    expect(refuseExtensionGroups([signage], [website, weather]).size).toBe(0);
  });
});

describe("refuseExtensionGroups beside a plugin with device routes", () => {
  // Signage as it ships: device routes, and a point that accepts names, which
  // reaches the screens through its residents addon (ADR 0031).
  const screens = manifest({
    id: "signage",
    personalData: ["name"],
    deviceRoutes: [{ id: "screen", path: "screen" }],
    extensionPoints: [{ id: "source", version: 1, personalData: ["name"] }],
  });

  function extending(
    id: string,
    permissions: string[],
    overrides: Record<string, unknown> = {},
  ): PluginManifest {
    return manifest({
      id,
      permissions,
      extends: [{ plugin: "signage", point: "source", version: 1 }],
      ...overrides,
    });
  }

  const residents = extending("signage-residents", ["addressBook:read"], {
    personalData: ["name"],
  });

  it("lets an addon serve that reads names and apartments", () => {
    expect(refuseExtensionGroups([screens], [residents]).size).toBe(0);
  });

  it.each([
    ["addressBook:readContact", ["name", "email", "phone"]],
    ["finances:read", []],
    ["addressBook:proposeImport", memberList],
  ])(
    "refuses an addon that asks for %s, whatever it says it hands over",
    (permission, personalData) => {
      // It declares handing over nothing; only its own manifest says so.
      const reader = extending("signage-reader", [permission], {
        personalData,
      });

      expect(refuseExtensionGroups([screens], [residents, reader])).toEqual(
        new Map([
          [
            "signage-reader",
            {
              reason: "extension-device-group-refused",
              detail: { device: ["signage"], register: ["signage-reader"] },
            },
          ],
        ]),
      );
    },
  );

  it("refuses the addon that joins a plugin with device routes to one that reads contact details", () => {
    const directory = manifest({
      id: "directory",
      permissions: ["addressBook:readContact"],
      personalData: ["name", "email", "phone"],
      extensionPoints: [{ id: "entry", version: 1 }],
    });
    const bridge = extending("bridge", [], {
      extends: [
        { plugin: "signage", point: "source", version: 1 },
        { plugin: "directory", point: "entry", version: 1 },
      ],
    });

    expect(
      refuseExtensionGroups([directory, screens], [residents, bridge]),
    ).toEqual(
      new Map([
        [
          "bridge",
          {
            reason: "extension-device-group-refused",
            detail: { device: ["signage"], register: ["directory"] },
          },
        ],
      ]),
    );
  });

  it("refuses an addon with device routes before one that reads the finances", () => {
    // Both are addons of one host plugin that reads nothing. The screen is
    // what may not be shown the books, so the screen gives way.
    const host = manifest({
      id: "signage",
      extensionPoints: [{ id: "source", version: 1 }],
    });
    const lobby = extending("lobby-screen", [], {
      deviceRoutes: [{ id: "screen", path: "screen" }],
    });
    const books = extending("signage-books", ["finances:read"]);

    for (const addons of [
      [lobby, books],
      [books, lobby],
    ]) {
      expect(refuseExtensionGroups([host], addons)).toEqual(
        new Map([
          [
            "lobby-screen",
            {
              reason: "extension-device-group-refused",
              detail: {
                device: ["lobby-screen"],
                register: ["signage-books"],
              },
            },
          ],
        ]),
      );
    }
  });

  it("refuses an addon once, under the first rule it breaks", () => {
    // A website host plugin's addon that reads contact details breaks the
    // website's rule, and is gone before the device's rule is read. The screen
    // plugin declares names, so the website's rule reads it among those that
    // reach the members' details.
    const noticeboard = manifest({
      id: "noticeboard",
      permissions: ["site:blocks"],
      extensionPoints: [{ id: "notice", version: 1 }],
    });
    const contacts = extending("contacts", ["addressBook:readContact"], {
      personalData: ["name", "email"],
      extends: [
        { plugin: "noticeboard", point: "notice", version: 1 },
        { plugin: "signage", point: "source", version: 1 },
      ],
    });

    expect(refuseExtensionGroups([noticeboard, screens], [contacts])).toEqual(
      new Map([
        [
          "contacts",
          {
            reason: "extension-group-refused",
            detail: {
              website: ["noticeboard"],
              register: ["contacts", "signage"],
            },
          },
        ],
      ]),
    );
  });
});
