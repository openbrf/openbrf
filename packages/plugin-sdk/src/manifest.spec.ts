import { describe, expect, it } from "vite-plus/test";

import { ACTION_PERSONAL_DATA } from "./actions.ts";
import { PLUGIN_API_VERSION } from "./api-version.ts";
import { pluginBlockType } from "./blocks.ts";
import {
  assertPluginPackage,
  composedActionName,
  parsePluginPackage,
  PLUGIN_VIEW_SECTIONS,
} from "./manifest.ts";
import {
  PLUGIN_PERMISSIONS,
  PLUGIN_PERSONAL_DATA_CATEGORIES,
  REGISTER_READING_PERMISSIONS,
} from "./permissions.ts";

function manifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: "@openbrf/example-plugin",
    version: "1.0.0",
    openbrf: {
      apiVersion: PLUGIN_API_VERSION,
      id: "example",
      entry: { server: "./dist/server.cjs" },
      ...overrides,
    },
  };
}

describe("parsePluginPackage", () => {
  it("accepts a minimal manifest and fills the optional lists", () => {
    const result = parsePluginPackage(manifest());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.openbrf.permissions).toEqual([]);
    expect(result.value.openbrf.personalData).toEqual([]);
  });

  it("reads a manifest that says nothing about ai as no AI package", () => {
    // The plugin channel, as every plugin had before the field existed.
    const result = parsePluginPackage(manifest());

    expect(result.ok && result.value.openbrf.ai).toBe(false);
  });

  it("reads one that declares ai as an AI package", () => {
    const result = parsePluginPackage(manifest({ ai: true }));

    expect(result.ok && result.value.openbrf.ai).toBe(true);
  });

  it.each([["ai"], [1], ["true"], [null]])(
    "refuses ai declared as %j, which is no yes or no",
    (value) => {
      // A channel name in its place is the mistake this guards: the manifest
      // says what the plugin is, and the host decides the channel from it.
      expect(parsePluginPackage(manifest({ ai: value })).ok).toBe(false);
    },
  );

  it("reports every problem at once rather than the first", () => {
    const result = parsePluginPackage({
      name: "x",
      version: "1.0.0",
      openbrf: { apiVersion: 1, id: "NOT VALID", entry: {} },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.length).toBeGreaterThan(1);
    expect(result.issues.join("\n")).toContain("openbrf.id");
  });

  it("requires at least one entry point", () => {
    const result = parsePluginPackage(manifest({ entry: {} }));
    expect(result.ok).toBe(false);
  });

  // A plugin id is joined onto /data/plugins and onto a URL. Every one of
  // these would escape one of the two.
  it.each([
    ["../escape", "a parent segment"],
    ["with.dot", "a dot"],
    ["with/slash", "a slash"],
    ["UPPER", "uppercase"],
    ["-leading", "a leading hyphen"],
    ["a", "a single character"],
  ])("rejects the id %s (%s)", (id) => {
    expect(parsePluginPackage(manifest({ id })).ok).toBe(false);
  });

  it("accepts a hyphenated id", () => {
    expect(parsePluginPackage(manifest({ id: "occupancy-board" })).ok).toBe(
      true,
    );
  });

  // The entry path is read from a manifest that arrived over the network and
  // is then joined onto the plugin's directory.
  it.each([
    "../../../etc/passwd",
    "/etc/passwd",
    "dist/../../escape.cjs",
    "dist/\0.cjs",
  ])("rejects the entry path %j", (server) => {
    expect(parsePluginPackage(manifest({ entry: { server } })).ok).toBe(false);
  });

  it("rejects an unknown permission", () => {
    expect(
      parsePluginPackage(manifest({ permissions: ["database:write"] })).ok,
    ).toBe(false);
  });

  it("rejects an unknown personal data category", () => {
    expect(
      parsePluginPackage(manifest({ personalData: ["biometrics"] })).ok,
    ).toBe(false);
  });

  it("accepts the categories a plugin handles through the actions it calls", () => {
    // An assistant passing issue reports and minutes to a model provider
    // handles free text, and one reading charges handles financial data. The
    // register's five alone would understate both on the consent screen and in
    // the record of processing activities.
    const result = parsePluginPackage(
      manifest({ personalData: ["name", "freeText", "financial", "health"] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.openbrf.personalData).toEqual([
      "name",
      "freeText",
      "financial",
      "health",
    ]);
  });

  it("offers a plugin every action category except the two it cannot reach", () => {
    expect([...PLUGIN_PERSONAL_DATA_CATEGORIES]).toEqual(
      ACTION_PERSONAL_DATA.filter(
        (category) =>
          category !== "personalIdentityNumber" && category !== "protected",
      ),
    );
  });

  it.each(["personalIdentityNumber", "protected"])(
    "rejects %s, which no plugin can reach",
    (category) => {
      // A personal identity number is never returned to a plugin, and a person
      // with protected personal data never appears in its reads. A declaration
      // naming either would describe a processing that cannot happen.
      const result = parsePluginPackage(
        manifest({ personalData: ["name", category] }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.issues.join("\n")).toContain("openbrf.personalData.1");
    },
  );

  it("rejects duplicate settings keys", () => {
    const result = parsePluginPackage(
      manifest({
        settingsSchema: {
          fields: [
            { key: "greeting", labelKey: "settings.a", type: "text" },
            { key: "greeting", labelKey: "settings.b", type: "text" },
          ],
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("defaults the view module to ./View", () => {
    const result = parsePluginPackage(
      manifest({ view: { titleKey: "view.title" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.openbrf.view?.module).toBe("./View");
  });

  // A view written before the field existed names no section, and is reachable
  // by its address alone as it was.
  it("leaves a view without a section out of the navigation", () => {
    const result = parsePluginPackage(
      manifest({ view: { titleKey: "view.title" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.openbrf.view?.section).toBeUndefined();
  });

  it.each(PLUGIN_VIEW_SECTIONS)(
    "accepts the %s section for a view",
    (section) => {
      const result = parsePluginPackage(
        manifest({ view: { titleKey: "view.title", section } }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.openbrf.view?.section).toBe(section);
    },
  );

  it("refuses a section the application does not have", () => {
    const result = parsePluginPackage(
      manifest({ view: { titleKey: "view.title", section: "plugins" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toEqual([
      expect.stringMatching(/^openbrf\.view\.section: /),
    ]);
  });

  // The installer resolves nothing from a registry, so a package that names a
  // runtime dependency is refused rather than handed to npm to fetch.
  it.each([
    ["dependencies", { "date-fns": "^4.0.0" }],
    ["optionalDependencies", { "date-fns": "^4.0.0" }],
    ["bundleDependencies", ["date-fns"]],
    ["bundledDependencies", ["date-fns"]],
  ])("refuses a package that lists a package under %s", (field, value) => {
    const result = parsePluginPackage({
      ...(manifest() as Record<string, unknown>),
      [field]: value,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toEqual([
      `${field}: names date-fns; a plugin declares no runtime dependencies, because the installer resolves nothing from a registry`,
    ]);
  });

  // npm reads a string as a list of names and goes looking for them, so a
  // field that is not a map or a list is refused however it is spelled.
  it.each([
    ["a string", "left-pad"],
    ["null", null],
    ["a list of something other than names", [1]],
  ])("refuses a dependencies field given as %s", (_, value) => {
    const result = parsePluginPackage({
      ...(manifest() as Record<string, unknown>),
      dependencies: value,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toEqual([
      "dependencies: is neither an empty map nor an empty list; a plugin declares no runtime dependencies, because the installer resolves nothing from a registry",
    ]);
  });

  it("accepts an empty dependencies block and peer dependencies", () => {
    const result = parsePluginPackage({
      ...(manifest() as Record<string, unknown>),
      dependencies: {},
      peerDependencies: { "@nestjs/common": "^12.0.0" },
    });

    expect(result.ok).toBe(true);
  });
});

describe("assertPluginPackage", () => {
  it("throws with the problems listed", () => {
    expect(() => assertPluginPackage({})).toThrow(/Invalid Open BRF plugin/);
  });

  it("returns the parsed manifest when valid", () => {
    expect(assertPluginPackage(manifest()).openbrf.id).toBe("example");
  });
});

describe("the actions a manifest proposes", () => {
  it("defaults to none, and to the in-process surface when one is declared", () => {
    const result = parsePluginPackage(
      manifest({
        actions: [{ id: "summary", capability: "self:manage", effect: "read" }],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [action] = result.value.openbrf.actions;
    expect(action?.surfaces).toEqual(["ui"]);
    expect(action?.personalData).toEqual([]);
  });

  it("refuses two declarations wearing one id", () => {
    /*
     * Not a redundancy that sorts itself out: the three readers resolve it
     * differently. The binder takes the last through a Map; consent compares
     * canonical strings as a set, so swapping the pair over leaves the
     * comparison equal and asks the board nothing; and arming stores the bare
     * id, which names both. A republished version that only reordered the pair
     * would keep its arming and go live at the other declaration's capability,
     * with nobody having decided it.
     */
    const result = parsePluginPackage(
      manifest({
        actions: [
          { id: "summary", capability: "self:manage", effect: "read" },
          { id: "summary", capability: "site:manage", effect: "write" },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.join("\n")).toContain("summary");
  });

  it("refuses a composed name too long to be offered", () => {
    /*
     * A plugin id runs to 48 characters and an action id to 32, which composes
     * to 81 against a public limit of 64. Only the pair knows, so the refusal
     * is pairwise rather than a shorter bound on the action id: that would
     * charge every plugin for the longest possible plugin id.
     *
     * Refused at parse time, which is before the install consent screen, rather
     * than as a finding after the plugin's code has run.
     */
    const result = parsePluginPackage(
      manifest({
        id: "a".repeat(48),
        actions: [
          {
            id: `b${"c".repeat(31)}`,
            capability: "self:manage",
            effect: "read",
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(JSON.stringify(result.issues)).toContain("64");
  });

  it("accepts a long action id for a short plugin id", () => {
    const result = parsePluginPackage(
      manifest({
        id: "brf",
        actions: [
          {
            id: "monthly_occupancy_report",
            capability: "addressBook:read",
            effect: "read",
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("folds the dashes in a plugin id, and says so", () => {
    // The folding is why two different plugins can compose the same public
    // name: `a-b` declaring `c` and `a` declaring `b_c`. The registry refuses
    // the second to arrive; here the shape is pinned.
    expect(composedActionName("mcp-connector", "post_news")).toBe(
      "mcp_connector_post_news",
    );
  });
});

describe("the website blocks a manifest declares", () => {
  const counter = {
    name: "counter",
    labelKey: "blocks.counter.label",
    settingsSchema: {
      fields: [
        {
          key: "count",
          labelKey: "blocks.counter.count",
          type: "number",
          integer: true,
          min: 1,
          max: 10,
          default: 3,
        },
      ],
    },
  };

  it("defaults to none, and fills a block's icon and category", () => {
    const none = parsePluginPackage(manifest());
    expect(none.ok && none.value.openbrf.blocks).toEqual([]);

    const result = parsePluginPackage(
      manifest({ permissions: ["site:blocks"], blocks: [counter] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.openbrf.blocks[0]).toMatchObject({
      name: "counter",
      icon: "plugin",
      category: "association",
    });
  });

  it("asks for the site:blocks permission", () => {
    const result = parsePluginPackage(manifest({ blocks: [counter] }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join("\n")).toContain(
      'blocks: a plugin that declares blocks must ask for the "site:blocks" permission',
    );
  });

  it.each([...REGISTER_READING_PERMISSIONS])(
    "refuses site:blocks beside %s",
    (permission) => {
      const result = parsePluginPackage(
        manifest({ permissions: ["site:blocks", permission] }),
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues.join("\n")).toContain(
        "may not also read the address book or the finances",
      );
      // The code the interface translates, beside the line for the author.
      expect(!result.ok && result.diagnostics.map(({ rule }) => rule)).toEqual([
        "blocks-read-register",
      ]);
    },
  );

  it("allows site:blocks beside every permission that does not read the register", () => {
    const others = PLUGIN_PERMISSIONS.filter(
      (permission) => !REGISTER_READING_PERMISSIONS.includes(permission),
    );

    expect(others).toContain("mail:send");
    expect(
      parsePluginPackage(manifest({ permissions: ["site:blocks", ...others] }))
        .ok,
    ).toBe(true);
  });

  it("refuses two blocks wearing one name", () => {
    const result = parsePluginPackage(
      manifest({ permissions: ["site:blocks"], blocks: [counter, counter] }),
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join("\n")).toContain(
      'blocks.1.name: two blocks are declared with the name "counter"',
    );
  });

  it.each([
    ["a name that is not one word", { name: "my-block" }],
    ["a name with a slash", { name: "other/counter" }],
    ["an icon the editor cannot draw", { icon: "rocket" }],
    ["the layout category", { category: "layout" }],
    ["a field it does not know", { render: "./dist/block.js" }],
  ])("refuses %s", (_what, change) => {
    const result = parsePluginPackage(
      manifest({
        permissions: ["site:blocks"],
        blocks: [{ ...counter, ...change }],
      }),
    );

    expect(result.ok).toBe(false);
  });

  it("composes the type id a page stores", () => {
    expect(pluginBlockType("example", "counter")).toBe("example/counter");
  });
});

describe("the device routes a manifest declares (ADR 0031)", () => {
  function issues(overrides: Record<string, unknown>): string[] {
    const result = parsePluginPackage(manifest(overrides));
    return result.ok ? [] : result.issues;
  }

  it("defaults to none and reads a declared route", () => {
    const none = parsePluginPackage(manifest());
    expect(none.ok && none.value.openbrf.deviceRoutes).toEqual([]);

    const declared = parsePluginPackage(
      manifest({ deviceRoutes: [{ id: "screen", path: "screen" }] }),
    );
    expect(declared.ok && declared.value.openbrf.deviceRoutes).toEqual([
      { id: "screen", path: "screen" },
    ]);
  });

  it("refuses a path that is not a route under the plugin's own mount", () => {
    for (const path of ["/screen", "screen/", "../core", "Screen", "a//b"]) {
      expect(
        issues({ deviceRoutes: [{ id: "screen", path }] }).join("\n"),
      ).toContain("deviceRoutes.0.path");
    }
  });

  it("refuses an id outside its alphabet or length", () => {
    for (const id of ["s", "Screen", "screen_1", "-screen", "a".repeat(33)]) {
      expect(
        issues({ deviceRoutes: [{ id, path: "screen" }] }).join("\n"),
      ).toContain("deviceRoutes.0.id");
    }
  });

  it("refuses more than four routes", () => {
    const routes = ["a1", "b2", "c3", "d4", "e5"].map((id) => ({
      id,
      path: id,
    }));
    expect(issues({ deviceRoutes: routes })).not.toEqual([]);
    expect(issues({ deviceRoutes: routes.slice(0, 4) })).toEqual([]);
  });

  it("refuses two routes with one id, or one route inside another", () => {
    expect(
      issues({
        deviceRoutes: [
          { id: "screen", path: "screen" },
          { id: "screen", path: "other" },
        ],
      }).join("\n"),
    ).toContain('two device routes are declared with the id "screen"');
    expect(
      issues({
        deviceRoutes: [
          { id: "screen", path: "screen" },
          { id: "pictures", path: "screen/pictures" },
        ],
      }).join("\n"),
    ).toContain("overlaps");
    // A shared prefix of letters is not a shared path.
    expect(
      issues({
        deviceRoutes: [
          { id: "screen", path: "screen" },
          { id: "screens", path: "screens" },
        ],
      }),
    ).toEqual([]);
  });

  it("refuses a route that overlaps the OAuth protected resource", () => {
    expect(
      issues({
        oauthProtectedResource: "mcp",
        deviceRoutes: [{ id: "screen", path: "mcp/screen" }],
      }).join("\n"),
    ).toContain("oauthProtectedResource");
  });

  it.each([...REGISTER_READING_PERMISSIONS])(
    "refuses a plugin with a device route that asks for %s",
    (permission) => {
      const result = parsePluginPackage(
        manifest({
          permissions: [permission],
          deviceRoutes: [{ id: "screen", path: "screen" }],
        }),
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues.join("\n")).toContain(
        "may not also read the address book or the finances",
      );
      expect(!result.ok && result.diagnostics.map(({ rule }) => rule)).toEqual([
        "device-route-reads-register",
      ]);
    },
  );

  it("allows a device route beside every permission that does not read the register", () => {
    const others = PLUGIN_PERMISSIONS.filter(
      (permission) => !REGISTER_READING_PERMISSIONS.includes(permission),
    );

    expect(others).toContain("finances:recordDelivery");
    expect(
      issues({
        permissions: others,
        deviceRoutes: [{ id: "screen", path: "screen" }],
      }),
    ).toEqual([]);
  });

  it("carries the code of a route that overlaps the OAuth protected resource", () => {
    const result = parsePluginPackage(
      manifest({
        oauthProtectedResource: "mcp",
        deviceRoutes: [{ id: "screen", path: "mcp/screen" }],
      }),
    );

    expect(!result.ok && result.diagnostics).toEqual([
      {
        rule: "device-route-overlaps-oauth-resource",
        issue: expect.stringContaining("oauthProtectedResource"),
      },
    ]);
  });

  it("gives a field's own problem no rule", () => {
    const result = parsePluginPackage(manifest({ id: "NOT VALID" }));

    expect(!result.ok && result.diagnostics.map(({ rule }) => rule)).toEqual([
      null,
    ]);
  });
});

describe("the licence a manifest declares", () => {
  // Any 32 bytes are a key as far as the shape is concerned.
  const KEY = `${"A".repeat(42)}E=`;

  function licensed(
    licence: Record<string, unknown>,
    released: string | null = "2026-12-01",
  ): unknown {
    return manifest({
      licence: {
        entitlement: "mcp-connector",
        issuer: { name: "Apteo AB", url: "https://openbrf.se/licence" },
        keys: { "apteo-2026-1": KEY },
        ...licence,
      },
      ...(released === null ? {} : { released }),
    });
  }

  function issues(input: unknown): string {
    const result = parsePluginPackage(input);
    return result.ok ? "" : result.issues.join("\n");
  }

  it("accepts a licence with no audiences and fills the list", () => {
    const result = parsePluginPackage(licensed({}));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.openbrf.licence?.audiences).toEqual([]);
      expect(result.value.openbrf.released).toBe("2026-12-01");
    }
  });

  it("requires a release date with a licence", () => {
    expect(issues(licensed({}, null))).toContain("openbrf.released");
  });

  it.each(["2027-02-30", "2026-13-01", "2026-1-01", "01-12-2026"])(
    "refuses %s as a release date",
    (released) => {
      expect(issues(licensed({}, released))).toContain("openbrf.released");
    },
  );

  it.each(["1mcp", "MCP", "mcp--connector", "m"])(
    "refuses the entitlement name %s, which is not written as a plugin id is",
    (entitlement) => {
      expect(issues(licensed({ entitlement }))).toContain(
        "openbrf.licence.entitlement",
      );
    },
  );

  it("refuses a field it does not know", () => {
    expect(
      issues(licensed({ audience: "https://themes.openbrf.se" })),
    ).toContain("openbrf.licence");
  });

  it("refuses no keys, three keys and a key id outside its alphabet", () => {
    expect(issues(licensed({ keys: {} }))).toContain("openbrf.licence.keys");
    expect(issues(licensed({ keys: { a: KEY, b: KEY, c: KEY } }))).toContain(
      "openbrf.licence.keys",
    );
    expect(issues(licensed({ keys: { Apteo: KEY } }))).toContain(
      "openbrf.licence.keys",
    );
  });

  it.each([
    ["too short", "A".repeat(43)],
    ["unpadded", "A".repeat(43) + "A"],
    ["base64url", `${"_".repeat(42)}E=`],
    // Decodes to the same 32 bytes as KEY ends with, in a second spelling.
    ["non-canonical", `${"A".repeat(42)}F=`],
  ])("refuses a public key that is %s", (_, key) => {
    expect(issues(licensed({ keys: { "apteo-2026-1": key } }))).toContain(
      "openbrf.licence.keys",
    );
  });

  it.each([
    "https://themes.openbrf.se",
    "https://themes.openbrf.se:8443",
    "https://xn--grns-loa.example",
    "https://localhost",
  ])("accepts the audience %s", (audience) => {
    expect(parsePluginPackage(licensed({ audiences: [audience] })).ok).toBe(
      true,
    );
  });

  it.each([
    ["plain http", "http://themes.openbrf.se"],
    ["a trailing slash", "https://themes.openbrf.se/"],
    ["a path", "https://themes.openbrf.se/v1"],
    ["upper case", "https://Themes.openbrf.se"],
    ["the default port", "https://themes.openbrf.se:443"],
    ["a port with a leading zero", "https://themes.openbrf.se:08443"],
    ["a port out of range", "https://themes.openbrf.se:70000"],
    ["userinfo", "https://user@themes.openbrf.se"],
    ["a query", "https://themes.openbrf.se?x=1"],
    ["an IPv4 address", "https://127.0.0.1"],
    ["a hexadecimal IPv4 address", "https://0x7f.1"],
    ["a label ending in a hyphen", "https://themes-.openbrf.se"],
    ["a trailing dot", "https://themes.openbrf.se."],
    ["unicode", "https://gräns.example"],
    [
      "more than 256 characters",
      `https://${Array.from({ length: 5 }, () => "a".repeat(50)).join(".")}`,
    ],
  ])("refuses an audience with %s", (_, audience) => {
    expect(issues(licensed({ audiences: [audience] }))).toContain(
      "openbrf.licence.audiences",
    );
  });

  it("refuses an audience named twice", () => {
    expect(
      issues(
        licensed({
          audiences: ["https://themes.openbrf.se", "https://themes.openbrf.se"],
        }),
      ),
    ).toContain("openbrf.licence.audiences");
  });

  it("refuses an issuer address that is not https", () => {
    expect(
      issues(
        licensed({ issuer: { name: "Apteo AB", url: "http://openbrf.se" } }),
      ),
    ).toContain("openbrf.licence.issuer.url");
  });
});
