import { describe, expect, it } from "vite-plus/test";

import { ACTION_PERSONAL_DATA } from "./actions.ts";
import { PLUGIN_API_VERSION } from "./api-version.ts";
import { pluginBlockType } from "./blocks.ts";
import {
  assertPluginPackage,
  composedActionName,
  type ExtensionGroupMember,
  extensionGroupRefusals,
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

  it("offers a plugin every action category, in the same order", () => {
    expect([...PLUGIN_PERSONAL_DATA_CATEGORIES]).toEqual([
      ...ACTION_PERSONAL_DATA,
    ]);
  });

  it.each(["personalIdentityNumber", "protected"])(
    "rejects %s from a plugin that does not propose imports",
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
      expect(result.issues.join("\n")).toContain(
        `openbrf.personalData: only a plugin that asks for "addressBook:proposeImport" may declare "${category}"`,
      );
    },
  );

  describe("a plugin that proposes imports", () => {
    const carried = [
      "name",
      "apartment",
      "residency",
      "email",
      "phone",
      "personalIdentityNumber",
      "protected",
    ];

    it("declares every category the member list holds", () => {
      const result = parsePluginPackage(
        manifest({
          permissions: ["addressBook:proposeImport"],
          personalData: carried,
        }),
      );

      expect(result.ok).toBe(true);
    });

    it.each(carried)("is refused without %s", (category) => {
      // The file can hold every name, contact detail and identity number in
      // the cooperative, and rows about protected persons, so the board is told
      // so before it consents.
      const result = parsePluginPackage(
        manifest({
          permissions: ["addressBook:proposeImport"],
          personalData: carried.filter((declared) => declared !== category),
        }),
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues.join("\n")).toContain(
        `must declare "${category}"`,
      );
    });

    it("is refused beside site:blocks", () => {
      // It reads nothing from the register, but it holds the member list, and
      // a block is published to anybody.
      const result = parsePluginPackage(
        manifest({
          permissions: ["addressBook:proposeImport", "site:blocks"],
          personalData: carried,
        }),
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues.join("\n")).toContain(
        "may not also propose imports",
      );
      expect(!result.ok && result.diagnostics.map(({ rule }) => rule)).toEqual([
        "blocks-propose-import",
      ]);
    });

    it("is refused with a device route", () => {
      const result = parsePluginPackage(
        manifest({
          permissions: ["addressBook:proposeImport"],
          personalData: carried,
          deviceRoutes: [{ id: "screen", path: "screen" }],
        }),
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues.join("\n")).toContain(
        "may not also propose imports",
      );
      expect(!result.ok && result.diagnostics.map(({ rule }) => rule)).toEqual([
        "device-route-proposes-import",
      ]);
    });
  });

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
    // Proposing an import reads nothing, but holds the member list and has
    // its own refusals beside both (ADR 0043).
    const others = PLUGIN_PERMISSIONS.filter(
      (permission) =>
        !REGISTER_READING_PERMISSIONS.includes(permission) &&
        permission !== "addressBook:proposeImport",
    );

    expect(others).toContain("mail:send");
    expect(
      parsePluginPackage(
        manifest({
          permissions: ["site:blocks", ...others],
          personalData: ["freeText", "photograph"],
        }),
      ).ok,
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

describe("the recipients a manifest declares", () => {
  const assistant = {
    id: "model-provider",
    origin: "https://api.anthropic.com",
    purpose: {
      sv: "Skickar texten styrelsen ber om hjälp med till språkmodellen.",
      en: "Sends the text the board asks for help with to the language model.",
    },
    personalData: ["freeText"],
  };

  it("defaults to none", () => {
    const result = parsePluginPackage(manifest());
    expect(result.ok && result.value.openbrf.recipients).toEqual([]);
  });

  it("accepts a recipient receiving categories the plugin declares", () => {
    const result = parsePluginPackage(
      manifest({ personalData: ["freeText"], recipients: [assistant] }),
    );
    expect(result.ok && result.value.openbrf.recipients).toEqual([assistant]);
  });

  // The categories a recipient receives are among the ones the plugin
  // handles, or the record of processing activities would not hear of them.
  it("refuses a recipient receiving a category the plugin does not declare", () => {
    const result = parsePluginPackage(
      manifest({ personalData: ["name"], recipients: [assistant] }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join("\n")).toContain(
      "openbrf.recipients.0.personalData.0",
    );
  });

  it("accepts a recipient that receives no personal data", () => {
    const result = parsePluginPackage(
      manifest({ recipients: [{ ...assistant, personalData: [] }] }),
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ["plain http", "http://api.anthropic.com"],
    ["a path", "https://api.anthropic.com/v1"],
    ["a trailing slash", "https://api.anthropic.com/"],
    ["the default port", "https://api.anthropic.com:443"],
    ["uppercase", "https://API.anthropic.com"],
    ["credentials", "https://user:pass@api.anthropic.com"],
    ["no scheme", "api.anthropic.com"],
    ["a trailing dot", "https://api.anthropic.com."],
    ["an IPv4 address", "https://203.0.113.7"],
    ["an IPv4 address in another spelling", "https://0x7f.1"],
    ["an IPv6 address", "https://[2001:db8::1]"],
    ["localhost", "https://localhost"],
    ["a localhost subdomain", "https://api.localhost:8443"],
  ])("refuses an origin with %s", (_label, origin) => {
    const result = parsePluginPackage(
      manifest({
        personalData: ["freeText"],
        recipients: [{ ...assistant, origin }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join("\n")).toContain(
      "openbrf.recipients.0.origin",
    );
  });

  it("accepts a port other than 443", () => {
    const result = parsePluginPackage(
      manifest({
        personalData: ["freeText"],
        recipients: [{ ...assistant, origin: "https://api.example.com:8443" }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ["id", { origin: "https://api.example.com" }, "id"],
    ["origin", { id: "second" }, "origin"],
  ])("refuses two recipients sharing one %s", (_label, change, field) => {
    const result = parsePluginPackage(
      manifest({
        personalData: ["freeText"],
        recipients: [assistant, { ...assistant, ...change }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join("\n")).toContain(
      `openbrf.recipients.1.${field}`,
    );
  });

  it("refuses a purpose in only one language", () => {
    const result = parsePluginPackage(
      manifest({
        personalData: ["freeText"],
        recipients: [{ ...assistant, purpose: { en: "Model" } }],
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("a secret field", () => {
  const secret = { key: "apiKey", labelKey: "settings.apiKey", type: "secret" };

  it("is accepted in the plugin's own settings", () => {
    const result = parsePluginPackage(
      manifest({ settingsSchema: { fields: [secret] } }),
    );
    expect(result.ok).toBe(true);
  });

  // A block's values are stored in the page and read by whoever renders it.
  it("is refused in a website block's settings", () => {
    const result = parsePluginPackage(
      manifest({
        permissions: ["site:blocks"],
        blocks: [
          {
            name: "counter",
            labelKey: "blocks.counter.label",
            settingsSchema: { fields: [secret] },
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join("\n")).toContain(
      "openbrf.blocks.0.settingsSchema",
    );
  });
});

/**
 * Extension points (ADR 0030). The rules here are the ones that open a path
 * from the register to a place the core keeps it out of, or that would make
 * "what can reach this screen" a question two consent screens cannot answer,
 * so each is refused before anything is downloaded.
 */
describe("extension points and extends", () => {
  const source = { id: "source", version: 1, personalData: ["name"] };
  const extendsSource = {
    plugin: "signage",
    point: "source",
    version: 1,
    personalData: ["name"],
  };

  function issues(overrides: Record<string, unknown>): string {
    const result = parsePluginPackage(manifest(overrides));
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.issues.join("\n");
  }

  it("defaults both lists to none", () => {
    const result = parsePluginPackage(manifest());
    expect(result.ok && result.value.openbrf.extensionPoints).toEqual([]);
    expect(result.ok && result.value.openbrf.extends).toEqual([]);
  });

  it("accepts a host plugin whose point accepts its own categories", () => {
    const result = parsePluginPackage(
      manifest({
        id: "signage",
        personalData: ["name", "apartment"],
        extensionPoints: [{ id: "source", version: 1 }],
      }),
    );

    expect(result.ok && result.value.openbrf.extensionPoints).toEqual([
      { id: "source", version: 1, personalData: [] },
    ]);
  });

  it("accepts an addon that hands over its own categories", () => {
    const result = parsePluginPackage(
      manifest({
        id: "signage-residents",
        permissions: ["addressBook:read"],
        personalData: ["name", "apartment"],
        extends: [extendsSource],
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a point that accepts a category the plugin does not handle", () => {
    expect(
      issues({ personalData: ["apartment"], extensionPoints: [source] }),
    ).toContain(
      "openbrf.extensionPoints.0.personalData: name must be among the plugin's own personalData",
    );
  });

  it("refuses an addon handing over a category it does not handle", () => {
    expect(
      issues({ personalData: ["apartment"], extends: [extendsSource] }),
    ).toContain(
      "openbrf.extends.0.personalData: name must be among the plugin's own personalData",
    );
  });

  it("refuses a point accepting personal data on a plugin with website blocks", () => {
    expect(
      issues({
        permissions: ["site:blocks"],
        personalData: ["name"],
        extensionPoints: [source],
      }),
    ).toContain(
      'a plugin that asks for "site:blocks" declares extension points',
    );
  });

  it("accepts a point with no personal data on a plugin with website blocks", () => {
    expect(
      parsePluginPackage(
        manifest({
          permissions: ["site:blocks"],
          extensionPoints: [{ id: "source", version: 1 }],
        }),
      ).ok,
    ).toBe(true);
  });

  it("refuses an addon that is extended in turn", () => {
    expect(
      issues({
        personalData: ["name"],
        extensionPoints: [source],
        extends: [extendsSource],
      }),
    ).toContain(
      "openbrf.extensionPoints: a plugin that extends another declares no extension points of its own",
    );
  });

  it("refuses a plugin that extends itself", () => {
    expect(
      issues({
        id: "signage",
        personalData: ["name"],
        extends: [extendsSource],
      }),
    ).toContain("openbrf.extends.0.plugin: a plugin does not extend itself");
  });

  it("refuses two points wearing one id", () => {
    expect(
      issues({
        extensionPoints: [
          { id: "source", version: 1 },
          { id: "source", version: 2 },
        ],
      }),
    ).toContain(
      'openbrf.extensionPoints.1.id: two extension points are declared with the id "source"',
    );
  });

  it("refuses extending one point twice", () => {
    expect(
      issues({
        extends: [
          { plugin: "signage", point: "source", version: 1 },
          { plugin: "signage", point: "source", version: 2 },
        ],
      }),
    ).toContain('"source" of "signage" is extended twice');
  });

  it("refuses more than eight points", () => {
    const points = Array.from({ length: 9 }, (_, index) => ({
      id: `point-${String(index)}`,
      version: 1,
    }));
    expect(issues({ extensionPoints: points })).toContain(
      "openbrf.extensionPoints",
    );
  });

  it.each([
    ["a version of zero", { id: "source", version: 0 }],
    ["a fractional version", { id: "source", version: 1.5 }],
    ["no version", { id: "source" }],
    ["an id with a dot", { id: "so.urce", version: 1 }],
    ["a one-character id", { id: "s", version: 1 }],
    ["an id of 33 characters", { id: "s".repeat(33), version: 1 }],
  ])("refuses a point with %s", (_what, point) => {
    expect(parsePluginPackage(manifest({ extensionPoints: [point] })).ok).toBe(
      false,
    );
  });
});

describe("the rule on plugins joined by extensions (ADR 0030)", () => {
  // A fixed sequence, so a failure names a set that fails every run.
  function sequence(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }

  const KINDS = [[], ["site:blocks"], ["addressBook:read"]] as const;

  function members(next: () => number): ExtensionGroupMember[] {
    const count = 2 + Math.floor(next() * 7);
    const ids = Array.from({ length: count }, (_, index) => `p${index}`);
    return ids.map((id) => {
      const extendsCount = next() < 0.3 ? 0 : 1 + Math.floor(next() * 3);
      // An addon may extend another addon here, as a catalog index may list.
      const targets = new Set(
        Array.from(
          { length: extendsCount },
          () => ids[Math.floor(next() * count)] ?? id,
        ).filter((target) => target !== id),
      );
      return {
        id,
        permissions: [...(KINDS[Math.floor(next() * 3)] ?? [])],
        extends: [...targets].map((plugin) => ({ plugin })),
      };
    });
  }

  function heldBoth(standing: readonly ExtensionGroupMember[]): boolean {
    const root = new Map(standing.map((member) => [member.id, member.id]));
    const find = (id: string): string => {
      const parent = root.get(id) ?? id;
      return parent === id ? id : find(parent);
    };
    for (const member of standing) {
      for (const { plugin } of member.extends) {
        if (root.has(plugin)) {
          root.set(find(member.id), find(plugin));
        }
      }
    }
    const kinds = new Map<string, Set<string>>();
    for (const member of standing) {
      const group = kinds.get(find(member.id)) ?? new Set();
      for (const permission of member.permissions) {
        group.add(permission);
      }
      kinds.set(find(member.id), group);
    }
    return [...kinds.values()].some(
      (group) => group.has("site:blocks") && group.has("addressBook:read"),
    );
  }

  it("leaves no group holding both kinds, refuses no host plugin, and reads no order", () => {
    const next = sequence(6175);
    for (let run = 0; run < 2000; run += 1) {
      const set = members(next);
      const refused = extensionGroupRefusals(set);

      expect(
        heldBoth(set.filter((member) => !refused.has(member.id))),
        JSON.stringify(set),
      ).toBe(false);
      for (const id of refused.keys()) {
        expect(
          set.find((member) => member.id === id)?.extends.length,
        ).toBeGreaterThan(0);
      }
      expect(
        [...extensionGroupRefusals([...set].reverse()).keys()].toSorted(),
      ).toEqual([...refused.keys()].toSorted());
    }
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
    // Proposing an import reads nothing, but holds the member list and has
    // its own refusals beside both (ADR 0043).
    const others = PLUGIN_PERMISSIONS.filter(
      (permission) =>
        !REGISTER_READING_PERMISSIONS.includes(permission) &&
        permission !== "addressBook:proposeImport",
    );

    expect(others).toContain("finances:recordDelivery");
    expect(
      issues({
        permissions: others,
        personalData: ["freeText", "photograph"],
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

describe("the content permissions", () => {
  it.each(["news:read", "calendar:read"])(
    "asks a plugin holding %s to declare freeText",
    (permission) => {
      const result = parsePluginPackage(
        manifest({ permissions: [permission], personalData: [] }),
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues.join("\n")).toContain(
        `personalData: a plugin that asks for "${permission}" must declare "freeText"`,
      );
    },
  );

  it("accepts news:read and calendar:read with freeText declared", () => {
    const result = parsePluginPackage(
      manifest({
        permissions: ["news:read", "calendar:read"],
        personalData: ["freeText"],
      }),
    );

    expect(result.ok).toBe(true);
  });

  it.each(["bookings:readAvailability", "addresses:read"])(
    "asks for no category with %s",
    (permission) => {
      // Free and busy and the house's addresses name nobody, so there is
      // nothing for either to declare.
      const result = parsePluginPackage(
        manifest({ permissions: [permission] }),
      );

      expect(result.ok).toBe(true);
    },
  );

  it("asks a plugin holding media:read to declare photograph", () => {
    // The host opens only a picture declared to show nobody recognisable, but
    // a photograph is a category whoever is in it.
    const result = parsePluginPackage(
      manifest({ permissions: ["media:read"], personalData: ["freeText"] }),
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join("\n")).toContain(
      'personalData: a plugin that asks for "media:read" must declare "photograph"',
    );
  });

  it("accepts media:read with photograph declared", () => {
    const result = parsePluginPackage(
      manifest({ permissions: ["media:read"], personalData: ["photograph"] }),
    );

    expect(result.ok).toBe(true);
  });

  it("allows a content permission beside site:blocks", () => {
    // Unlike the address book, what these read is already published, and the
    // audience on every item is the plugin's to respect.
    const result = parsePluginPackage(
      manifest({
        permissions: ["site:blocks", "calendar:read"],
        personalData: ["freeText"],
      }),
    );

    expect(result.ok).toBe(true);
  });
});
