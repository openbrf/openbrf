import { describe, expect, it } from "vite-plus/test";

import { ACTION_PERSONAL_DATA } from "./actions.ts";
import { PLUGIN_API_VERSION } from "./api-version.ts";
import { pluginBlockType } from "./blocks.ts";
import {
  assertPluginPackage,
  composedActionName,
  missingProcessingProblem,
  undeclaredPersonalDataProblem,
  parsePluginPackage,
  PLUGIN_VIEW_SECTIONS,
} from "./manifest.ts";
import { PLUGIN_PERSONAL_DATA_CATEGORIES } from "./permissions.ts";

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

  it.each(["addressBook:read", "addressBook:readContact", "finances:read"])(
    "refuses site:blocks beside %s",
    (permission) => {
      const result = parsePluginPackage(
        manifest({ permissions: ["site:blocks", permission] }),
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues.join("\n")).toContain(
        "may not also read the address book or the finances",
      );
    },
  );

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

describe("the processing a manifest declares (ADR 0035)", () => {
  const PROCESSING = {
    purpose: {
      sv: "Visa vilket hushåll som bor bakom vilken dörr.",
      en: "Show which household lives behind which door.",
    },
    legalBasis: "legitimateInterest",
    legitimateInterest: {
      sv: "Att hitta rätt dörr, som namntavlan i entrén alltid gjort.",
      en: "Finding the right door, as the name board always has.",
    },
    retention: {
      sv: "Så länge boendet varar.",
      en: "For as long as the residency lasts.",
    },
    dataSubjects: ["members", "residents"],
  };

  function issues(overrides: Record<string, unknown>): string {
    const result = parsePluginPackage(manifest(overrides));
    return result.ok ? "" : result.issues.join("\n");
  }

  it("accepts a declaration beside the personal data it is about", () => {
    const result = parsePluginPackage(
      manifest({ personalData: ["name"], processing: PROCESSING }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.openbrf.processing).toEqual(PROCESSING);
    }
  });

  it("refuses a declaration from a plugin that declares no personal data", () => {
    expect(issues({ processing: PROCESSING })).toContain("openbrf.processing");
  });

  it("names the interest on legitimate interest, and only there", () => {
    const { legitimateInterest: _interest, ...withoutInterest } = PROCESSING;

    expect(
      issues({ personalData: ["name"], processing: withoutInterest }),
    ).toContain("openbrf.processing.legitimateInterest");
    expect(
      issues({
        personalData: ["name"],
        processing: { ...PROCESSING, legalBasis: "contract" },
      }),
    ).toContain("openbrf.processing.legitimateInterest");
  });

  it("offers four bases, and not vital interests or public task", () => {
    for (const legalBasis of ["vitalInterests", "publicTask"]) {
      expect(
        issues({
          personalData: ["name"],
          processing: { ...PROCESSING, legalBasis },
        }),
      ).toContain("openbrf.processing.legalBasis");
    }
  });

  it("refuses a misspelled field rather than dropping it", () => {
    expect(
      issues({
        personalData: ["name"],
        processing: { ...PROCESSING, dataSubjectCategories: ["members"] },
      }),
    ).toContain("openbrf.processing");
  });

  it("refuses text in one language only, text over 500 characters, and no data subjects", () => {
    expect(
      issues({
        personalData: ["name"],
        processing: { ...PROCESSING, retention: { sv: "Ett år." } },
      }),
    ).toContain("openbrf.processing.retention");
    expect(
      issues({
        personalData: ["name"],
        processing: {
          ...PROCESSING,
          purpose: { sv: "x".repeat(501), en: "x" },
        },
      }),
    ).toContain("openbrf.processing.purpose.sv");
    expect(
      issues({
        personalData: ["name"],
        processing: { ...PROCESSING, dataSubjects: [] },
      }),
    ).toContain("openbrf.processing.dataSubjects");
  });

  it("keeps loading a plugin published before the field, and says what it lacks", () => {
    const result = parsePluginPackage(manifest({ personalData: ["name"] }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(missingProcessingProblem(result.value.openbrf)).toContain(
        "declares its processing",
      );
    }
    expect(
      missingProcessingProblem({ personalData: [], processing: undefined }),
    ).toBeNull();
  });

  it("says when a plugin reads the address book and declares no personal data, and keeps loading it", () => {
    const result = parsePluginPackage(
      manifest({ permissions: ["addressBook:readContact"] }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(undeclaredPersonalDataProblem(result.value.openbrf)).toContain(
        "declares the personal data it reads",
      );
    }
    expect(
      undeclaredPersonalDataProblem({
        permissions: ["addressBook:read"],
        personalData: ["name"],
      }),
    ).toBeNull();
    expect(
      undeclaredPersonalDataProblem({ permissions: [], personalData: [] }),
    ).toBeNull();
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
