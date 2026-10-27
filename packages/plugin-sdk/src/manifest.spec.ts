import { describe, expect, it } from "vite-plus/test";

import { ACTION_PERSONAL_DATA } from "./actions.ts";
import { PLUGIN_API_VERSION } from "./api-version.ts";
import { pluginBlockType } from "./blocks.ts";
import {
  assertPluginPackage,
  boardViewRuleIssues,
  composedActionName,
  type ExtensionGroupMember,
  extensionGroupRefusals,
  type ExtensionGroupRuleMember,
  extensionGroupRuleRefusals,
  extensionRuleIssues,
  missingProcessingProblem,
  undeclaredPersonalDataProblem,
  parsePluginPackage,
  PLUGIN_VIEW_SECTIONS,
  residentRouteRuleIssues,
} from "./manifest.ts";
import {
  personRecordsBeyondConsent,
  samePersonRecordsTerms,
} from "./person-records.ts";
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
      // The categories it must declare are about the members as well.
      expect(!result.ok && result.diagnostics.map(({ rule }) => rule)).toEqual([
        "blocks-propose-import",
        "blocks-declare-member-data",
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

  describe("a board view beside the residents' view (ADR 0051)", () => {
    const view = {
      module: "./View",
      titleKey: "view.title",
      section: "building",
    };
    const boardView = {
      module: "./BoardView",
      titleKey: "boardView.title",
      capability: "bookings:configure",
    };

    function issues(overrides: Record<string, unknown>): string[] {
      const result = parsePluginPackage(
        manifest({ view, boardView, ...overrides }),
      );
      return result.ok ? [] : result.issues;
    }

    it("reads a manifest with one view as it did, with no board view", () => {
      const result = parsePluginPackage(manifest({ view }));

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.openbrf.boardView).toBeUndefined();
    });

    it("accepts the two views of a plugin that reads nothing", () => {
      const result = parsePluginPackage(manifest({ view, boardView }));

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.openbrf.boardView).toEqual(boardView);
    });

    it.each(["association", "building", "settings"])(
      "accepts the residents' view in the %s section",
      (section) => {
        expect(issues({ view: { ...view, section } })).toEqual([]);
      },
    );

    it("accepts the board view naming the board's section", () => {
      expect(issues({ boardView: { ...boardView, section: "board" } })).toEqual(
        [],
      );
    });

    it("refuses two views of the board", () => {
      expect(issues({ view: { ...view, section: "board" } })).toEqual([
        'openbrf.view.section: a plugin that declares a board view offers its view outside the "board" section: two views are two audiences',
      ]);
    });

    it.each(["association", "building", "settings"])(
      "refuses a second view in the %s section, which is not the board's",
      (section) => {
        expect(issues({ boardView: { ...boardView, section } })).toEqual([
          "openbrf.boardView.section: a board view stands in the \"board\" section: a plugin's second view is the board's",
        ]);
      },
    );

    it("refuses a board view with no view beside it", () => {
      expect(issues({ view: undefined })).toEqual([
        'openbrf.boardView: a board view is a second view, beside a view for the residents; a plugin with one view, for the board, declares it as view in the "board" section',
      ]);
    });

    it("refuses a residents' view that names no section beside a board view", () => {
      expect(
        issues({ view: { module: "./View", titleKey: "view.title" } }),
      ).toEqual([
        "openbrf.view.section: a plugin that declares a board view names its view's section, so each view's audience is declared",
      ]);
    });

    it("refuses a board view that is the view's own module", () => {
      expect(issues({ boardView: { ...boardView, module: "./View" } })).toEqual(
        [
          "openbrf.boardView.module: a board view is a module of its own, not the view's",
        ],
      );
    });

    it("refuses a board view with no capability to offer it on", () => {
      const { capability: _, ...withoutCapability } = boardView;

      expect(issues({ boardView: withoutCapability })).toEqual([
        expect.stringMatching(/^openbrf\.boardView\.capability: /),
      ]);
    });

    it("refuses a capability the instance does not have", () => {
      expect(
        issues({ boardView: { ...boardView, capability: "parking:manage" } }),
      ).toEqual([expect.stringMatching(/^openbrf\.boardView\.capability: /)]);
    });

    it.each(REGISTER_READING_PERMISSIONS)(
      "refuses a board view beside %s without resident routes",
      (permission) => {
        // Such a plugin answers only the board, so its view is the board's
        // already, and a second would be the same audience again.
        const refused = issues({ permissions: [permission] });

        expect(refused).toContain(
          "openbrf.boardView: a plugin that reads the address book or the finances answers only the board unless it declares residentRoutes, so its view is the board's already and it declares no second one",
        );
      },
    );

    it("lets resident routes carry a board view beside the address book", () => {
      // Read structurally, for the manifest that declares resident routes.
      expect(
        boardViewRuleIssues({
          permissions: ["addressBook:read"],
          view,
          boardView,
          residentRoutes: [{ path: "offers" }],
        }),
      ).toEqual([]);
    });

    it("has nothing to say about a plugin with no board view", () => {
      expect(
        boardViewRuleIssues({
          permissions: ["addressBook:read"],
          view: { ...view, section: "board" },
        }),
      ).toEqual([]);
    });
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

  it.each(
    PLUGIN_PERSONAL_DATA_CATEGORIES.filter(
      (category) =>
        category !== "freeText" &&
        category !== "photograph" &&
        // Refused beside site:blocks with the import permission they need.
        category !== "personalIdentityNumber" &&
        category !== "protected",
    ),
  )("refuses site:blocks beside the declared category %s", (category) => {
    // An action that returns it would be offered to the plugin, and a board
    // member on its route could have it handed names to print.
    const result = parsePluginPackage(
      manifest({ permissions: ["site:blocks"], personalData: [category] }),
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join("\n")).toContain(
      `a plugin that asks for "site:blocks" may not declare "${category}"`,
    );
    expect(!result.ok && result.diagnostics.map(({ rule }) => rule)).toEqual([
      "blocks-declare-member-data",
    ]);
  });

  it("allows site:blocks beside published text and pictures alone", () => {
    expect(
      parsePluginPackage(
        manifest({
          permissions: ["site:blocks", "news:read", "media:read"],
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

describe("the records about a person a manifest declares (ADR 0047)", () => {
  const PROCESSING = {
    purpose: { sv: "Låna ut parkeringsplatser.", en: "Lend parking spaces." },
    legalBasis: "contract",
    retention: { sv: "Två år.", en: "Two years." },
    dataSubjects: ["residents"],
  };
  const CLAIMS = {
    collection: "claims",
    titleKey: "records.claims.title",
    personalData: ["apartment"],
    keepAtMostDays: 730,
    fields: [
      { key: "space", labelKey: "records.claims.space", provided: true },
      { key: "status", labelKey: "records.claims.status" },
    ],
  };

  function declared(overrides: Record<string, unknown> = {}): unknown {
    return manifest({
      permissions: ["addressBook:read"],
      personalData: ["name", "apartment"],
      processing: PROCESSING,
      personRecords: [CLAIMS],
      ...overrides,
    });
  }

  function issues(overrides: Record<string, unknown>): string {
    const result = parsePluginPackage(declared(overrides));
    return result.ok ? "" : result.issues.join("\n");
  }

  it("accepts a collection, and reads an unmarked field as not provided", () => {
    const result = parsePluginPackage(declared());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.openbrf.personRecords).toEqual([
        {
          ...CLAIMS,
          fields: [CLAIMS.fields[0], { ...CLAIMS.fields[1], provided: false }],
        },
      ]);
    }
  });

  it("reads a manifest that declares none as keeping none", () => {
    const result = parsePluginPackage(manifest());

    expect(result.ok && result.value.openbrf.personRecords).toEqual([]);
  });

  it("refuses a collection without a processing declaration to belong to", () => {
    expect(issues({ processing: undefined })).toContain(
      "keeps records about a person declares its processing",
    );
  });

  it("refuses a category the plugin does not declare it handles", () => {
    expect(issues({ personalData: ["name"] })).toContain(
      "openbrf.personRecords.0.personalData",
    );
  });

  /*
   * Whether a write naming a person is accepted tells the plugin whether the
   * address book lists that person to it, so keeping records is a read of the
   * address book the board consents to by name.
   */
  it("refuses a collection from a plugin that does not read the address book", () => {
    expect(issues({ permissions: [] })).toContain(
      'openbrf.permissions: a plugin that keeps records about a person must ask for the "addressBook:read" permission',
    );
    expect(issues({ permissions: ["mail:send"] })).toContain(
      '"addressBook:read"',
    );
    expect(issues({ permissions: ["addressBook:readContact"] })).toBe("");
  });

  it.each([["personalIdentityNumber"], ["protected"]])(
    "refuses a collection holding %s, which no record may",
    (category) => {
      expect(
        issues({
          personalData: ["name", "apartment", category],
          personRecords: [{ ...CLAIMS, personalData: [category] }],
        }),
      ).toContain("openbrf.personRecords.0.personalData.0");
    },
  );

  it("bounds the erase date at five years, and at a day at least", () => {
    expect(
      issues({ personRecords: [{ ...CLAIMS, keepAtMostDays: 1830 }] }),
    ).toBe("");
    expect(
      issues({ personRecords: [{ ...CLAIMS, keepAtMostDays: 1831 }] }),
    ).toContain("openbrf.personRecords.0.keepAtMostDays");
    expect(
      issues({ personRecords: [{ ...CLAIMS, keepAtMostDays: 0 }] }),
    ).toContain("openbrf.personRecords.0.keepAtMostDays");
  });

  it("refuses a collection declared twice, a field named twice and more than eight collections", () => {
    expect(issues({ personRecords: [CLAIMS, CLAIMS] })).toContain(
      "openbrf.personRecords.1.collection",
    );
    expect(
      issues({
        personRecords: [
          { ...CLAIMS, fields: [CLAIMS.fields[0], CLAIMS.fields[0]] },
        ],
      }),
    ).toContain("openbrf.personRecords.0.fields.1.key");
    expect(
      issues({
        personRecords: Array.from({ length: 9 }, (_, index) => ({
          ...CLAIMS,
          collection: `claims-${String(index)}`,
        })),
      }),
    ).toContain("openbrf.personRecords");
  });

  it("refuses a misspelt field rather than dropping it", () => {
    expect(
      issues({
        personRecords: [
          {
            ...CLAIMS,
            fields: [{ key: "space", labelKey: "x", provied: true }],
          },
        ],
      }),
    ).toContain("openbrf.personRecords.0.fields.0");
    expect(
      issues({ personRecords: [{ ...CLAIMS, keepAtMost: 30 }] }),
    ).toContain("openbrf.personRecords.0");
  });
});

describe("what a republished version keeps about a person, against the consent", () => {
  const consented = [
    { collection: "claims", personalData: ["apartment"], keepAtMostDays: 730 },
  ];

  it("names a collection added, widened or kept longer", () => {
    expect(
      personRecordsBeyondConsent(
        [
          {
            collection: "claims",
            personalData: ["apartment", "name"],
            keepAtMostDays: 730,
          },
          {
            collection: "offers",
            personalData: ["apartment"],
            keepAtMostDays: 30,
          },
        ],
        consented,
      ),
    ).toEqual(["claims", "offers"]);
    expect(
      personRecordsBeyondConsent(
        [
          {
            collection: "claims",
            personalData: ["apartment"],
            keepAtMostDays: 731,
          },
        ],
        consented,
      ),
    ).toEqual(["claims"]);
  });

  it("lets through a collection that keeps less, or for less time, or none at all", () => {
    expect(
      personRecordsBeyondConsent(
        [{ collection: "claims", personalData: [], keepAtMostDays: 10 }],
        consented,
      ),
    ).toEqual([]);
    expect(personRecordsBeyondConsent([], consented)).toEqual([]);
  });

  it("compares two declarations whatever their order", () => {
    const other = {
      collection: "offers",
      personalData: ["apartment"],
      keepAtMostDays: 30,
    };
    expect(
      samePersonRecordsTerms([...consented, other], [other, ...consented]),
    ).toBe(true);
    expect(samePersonRecordsTerms(consented, [other])).toBe(false);
    expect(
      samePersonRecordsTerms(consented, [
        { ...consented[0], keepAtMostDays: 10 },
      ] as typeof consented),
    ).toBe(false);
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

  describe("on a plugin with device routes (ADR 0030)", () => {
    const deviceRoutes = [{ id: "screen", path: "screen" }];

    it.each(["email", "phone"])("refuses a point that accepts %s", (kind) => {
      expect(
        issues({
          personalData: ["name", kind],
          deviceRoutes,
          extensionPoints: [{ ...source, personalData: [kind] }],
        }),
      ).toContain(
        `openbrf.extensionPoints.0.personalData: a plugin that declares deviceRoutes declares no extension point that accepts ${kind}`,
      );
    });

    it("reports the refusal under a rule code, beside the English line", () => {
      const result = parsePluginPackage(
        manifest({
          personalData: ["name", "email"],
          deviceRoutes,
          extensionPoints: [{ ...source, personalData: ["email"] }],
        }),
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.diagnostics).toEqual([
        {
          rule: "device-route-extension-point-contact",
          issue: expect.stringContaining(
            "openbrf.extensionPoints.0.personalData: a plugin that declares deviceRoutes",
          ),
        },
      ]);
    });

    it("accepts a point that accepts email and phone without device routes", () => {
      expect(
        parsePluginPackage(
          manifest({
            personalData: ["email", "phone"],
            extensionPoints: [{ ...source, personalData: ["email", "phone"] }],
          }),
        ).ok,
      ).toBe(true);
    });

    it("finds no issue in a declaration that omits deviceRoutes", () => {
      // A caller of extensionRuleIssues need not supply deviceRoutes: the
      // manifest and the catalog parse to [], a hand-built declaration may not.
      expect(
        extensionRuleIssues({
          id: "example",
          permissions: [],
          personalData: ["email", "phone"],
          extensionPoints: [{ personalData: ["email", "phone"] }],
          extends: [],
        }),
      ).toEqual([]);
    });

    it("accepts a point that accepts other categories", () => {
      expect(
        parsePluginPackage(
          manifest({
            personalData: ["name", "apartment"],
            deviceRoutes,
            extensionPoints: [
              { ...source, personalData: ["name", "apartment"] },
            ],
          }),
        ).ok,
      ).toBe(true);
    });
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

// A fixed sequence, so a failure names a set that fails every run.
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("the rules on a group joined by extensions", () => {
  const signage = {
    id: "signage",
    permissions: [],
    deviceRoutes: [{ id: "screen", path: "screen" }],
    extends: [],
  };
  const contacts = {
    id: "signage-contacts",
    permissions: ["addressBook:readContact"],
    deviceRoutes: [],
    extends: [{ plugin: "signage" }],
  };
  const website = {
    id: "website",
    permissions: ["site:blocks"],
    deviceRoutes: [],
    extends: [],
  };
  const residents = {
    id: "website-residents",
    permissions: ["addressBook:read"],
    deviceRoutes: [],
    extends: [{ plugin: "website" }],
  };

  it("refuses an addon under the rule it breaks", () => {
    expect(
      extensionGroupRuleRefusals([signage, contacts, website, residents]),
    ).toEqual(
      new Map([
        [
          "signage-contacts",
          {
            reason: "extension-device-group-refused",
            device: ["signage"],
            register: ["signage-contacts"],
          },
        ],
        [
          "website-residents",
          {
            reason: "extension-group-refused",
            website: ["website"],
            register: ["website-residents"],
          },
        ],
      ]),
    );
  });

  // The call and the answer plugin API 1 published in @openbrf/plugin-sdk
  // 1.5.0: members without device routes, and refusals that name the website
  // and register plugins alone.
  it("keeps extensionGroupRefusals to the website rule a 1.5.0 caller reads", () => {
    expect(
      extensionGroupRefusals([{ id: "host", permissions: [], extends: [] }]),
    ).toEqual(new Map());
    expect(
      extensionGroupRefusals([
        { id: "website", permissions: ["site:blocks"], extends: [] },
        {
          id: "website-residents",
          permissions: ["addressBook:read"],
          extends: [{ plugin: "website" }],
        },
      ]),
    ).toStrictEqual(
      new Map([
        [
          "website-residents",
          { website: ["website"], register: ["website-residents"] },
        ],
      ]),
    );
    expect(extensionGroupRefusals([signage, contacts])).toEqual(new Map());
  });

  describe("an addon that declares personal data beside a plugin with device routes", () => {
    const declaring = (personalData: string[]) => ({
      id: "signage-declared",
      permissions: [],
      personalData,
      deviceRoutes: [],
      extends: [{ plugin: "signage" }],
    });

    it.each([
      ["email"],
      ["phone"],
      ["postalAddress"],
      ["financial"],
      ["account"],
      ["health"],
      ["auditTrail"],
      ["name", "email"],
    ])(
      "refuses an addon with no permission that declares %s",
      (...categories) => {
        expect(
          extensionGroupRuleRefusals([signage, declaring(categories)]),
        ).toEqual(
          new Map([
            [
              "signage-declared",
              {
                reason: "extension-device-group-refused",
                device: ["signage"],
                register: ["signage-declared"],
              },
            ],
          ]),
        );
      },
    );

    it("serves an addon that declares what a device may be shown", () => {
      expect(
        extensionGroupRuleRefusals([
          signage,
          declaring([
            "name",
            "apartment",
            "residency",
            "freeText",
            "photograph",
          ]),
        ]),
      ).toEqual(new Map());
    });

    it("reads a member without a declaration as declaring nothing", () => {
      const { personalData: _declared, ...undeclared } = declaring(["email"]);
      expect(extensionGroupRuleRefusals([signage, undeclared])).toEqual(
        new Map(),
      );
    });

    it("gives no addon way for a host plugin that declares it itself", () => {
      const host = { ...signage, personalData: ["phone"] };
      const refused = extensionGroupRuleRefusals([host, declaring(["name"])]);
      expect(refused).toEqual(new Map());
    });

    it("still refuses the same declaration beside a website plugin", () => {
      expect(
        extensionGroupRefusals([
          { ...signage, permissions: ["site:blocks"] },
          declaring(["email"]),
        ]).has("signage-declared"),
      ).toBe(true);
    });
  });

  it("refuses the addon that joins a device star to a register star, not the addons serving in them", () => {
    const bridge = {
      id: "bridge",
      permissions: [],
      deviceRoutes: [],
      extends: [{ plugin: "signage" }, { plugin: "ledger" }],
    };
    const ledger = {
      id: "ledger",
      permissions: ["finances:read"],
      deviceRoutes: [],
      extends: [],
    };
    const set = [signage, ledger, bridge];
    const refused = extensionGroupRuleRefusals(set);

    expect([...refused.keys()]).toEqual(["bridge"]);
    expect(extensionGroupRuleRefusals([...set].reverse())).toEqual(refused);
  });

  // A plugin of each kind either rule reads, and neutral ones.
  const KINDS = [
    { permissions: [], personalData: [], deviceRoutes: 0 },
    {
      permissions: ["site:blocks"],
      personalData: ["freeText"],
      deviceRoutes: 0,
    },
    { permissions: [], personalData: [], deviceRoutes: 1 },
    {
      permissions: ["addressBook:read"],
      personalData: ["name"],
      deviceRoutes: 0,
    },
    {
      permissions: ["addressBook:readContact"],
      personalData: [],
      deviceRoutes: 0,
    },
    { permissions: ["finances:read"], personalData: [], deviceRoutes: 0 },
    { permissions: [], personalData: ["name", "freeText"], deviceRoutes: 0 },
    { permissions: ["addressBook:read"], personalData: [], deviceRoutes: 1 },
    { permissions: [], personalData: ["email", "phone"], deviceRoutes: 0 },
    {
      permissions: [],
      personalData: ["residency", "photograph"],
      deviceRoutes: 0,
    },
  ] as const;

  type Generated = Required<ExtensionGroupRuleMember>;

  function generated(next: () => number): Generated[] {
    const count = 2 + Math.floor(next() * 7);
    const ids = Array.from({ length: count }, (_, index) => `p${index}`);
    return ids.map((id) => {
      const extendsCount = next() < 0.3 ? 0 : 1 + Math.floor(next() * 3);
      const targets = new Set(
        Array.from(
          { length: extendsCount },
          () => ids[Math.floor(next() * count)] ?? id,
        ).filter((target) => target !== id),
      );
      const kind = KINDS[Math.floor(next() * KINDS.length)] ?? KINDS[0];
      return {
        id,
        permissions: [...kind.permissions],
        personalData: [...kind.personalData],
        deviceRoutes: Array.from({ length: kind.deviceRoutes }, () => ({})),
        extends: [...targets].map((plugin) => ({ plugin })),
      };
    });
  }

  /** Whether any group joined by extensions holds both sides of either rule. */
  function heldBothSides(standing: readonly Generated[]): boolean {
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
    const groups = new Map<string, Generated[]>();
    for (const member of standing) {
      const group = groups.get(find(member.id)) ?? [];
      group.push(member);
      groups.set(find(member.id), group);
    }
    const holds = (member: Generated, held: readonly string[]) =>
      member.permissions.some((permission) => held.includes(permission));
    // Written out here, not read from the rules under test.
    const reachesWebsite = (member: Generated) =>
      holds(member, [
        "addressBook:read",
        "addressBook:readContact",
        "finances:read",
      ]) || member.personalData.includes("name");
    const reachesDevice = (member: Generated) =>
      holds(member, ["addressBook:readContact", "finances:read"]) ||
      member.personalData.some(
        (category) =>
          ![
            "name",
            "apartment",
            "residency",
            "freeText",
            "photograph",
          ].includes(category),
      );
    return [...groups.values()].some(
      (group) =>
        (group.some((member) => member.permissions.includes("site:blocks")) &&
          group.some(reachesWebsite)) ||
        (group.some((member) => member.deviceRoutes.length > 0) &&
          group.some(reachesDevice)),
    );
  }

  it("leaves no group holding both sides of either rule, refuses no host plugin, and reads no order", () => {
    const next = sequence(2718);
    for (let run = 0; run < 2000; run += 1) {
      const set = generated(next);
      const refused = extensionGroupRuleRefusals(set);

      expect(
        heldBothSides(set.filter((member) => !refused.has(member.id))),
        JSON.stringify(set),
      ).toBe(false);
      for (const id of refused.keys()) {
        expect(
          set.find((member) => member.id === id)?.extends.length,
        ).toBeGreaterThan(0);
      }
      expect(extensionGroupRuleRefusals([...set].reverse())).toEqual(refused);
    }
  });
});

describe("the rule on plugins joined by extensions (ADR 0030)", () => {
  // A website plugin, and two that reach the members' details: one by a
  // permission and one by declaring names an action may hand it.
  const KINDS = [
    { permissions: [], personalData: [] },
    { permissions: ["site:blocks"], personalData: ["freeText"] },
    { permissions: ["addressBook:read"], personalData: ["name"] },
    { permissions: [], personalData: ["name", "freeText"] },
  ] as const;

  function members(next: () => number): Required<ExtensionGroupMember>[] {
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
      const kind = KINDS[Math.floor(next() * KINDS.length)] ?? KINDS[0];
      return {
        id,
        permissions: [...kind.permissions],
        personalData: [...kind.personalData],
        extends: [...targets].map((plugin) => ({ plugin })),
      };
    });
  }

  function heldBoth(
    standing: readonly Required<ExtensionGroupMember>[],
  ): boolean {
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
      for (const held of [...member.permissions, ...member.personalData]) {
        group.add(held);
      }
      kinds.set(find(member.id), group);
    }
    return [...kinds.values()].some(
      (group) =>
        group.has("site:blocks") &&
        (group.has("addressBook:read") || group.has("name")),
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
      // The whole refusal, ids and the lists naming its cause, not only who is refused.
      expect(extensionGroupRefusals([...set].reverse())).toEqual(refused);
    }
  });

  it("refuses an addon that declares names beside a website host, with no permission", () => {
    // It may dispatch `motion_queue_list` on a board member's request and
    // return a name in a field of its output the point types as text.
    const refused = extensionGroupRefusals([
      {
        id: "site",
        permissions: ["site:blocks"],
        personalData: [],
        extends: [],
      },
      {
        id: "motions",
        permissions: [],
        personalData: ["name", "freeText"],
        extends: [{ plugin: "site" }],
      },
    ]);

    expect(refused).toEqual(
      new Map([["motions", { website: ["site"], register: ["motions"] }]]),
    );
  });

  it("refuses a website addon beside an addon that declares names on one host", () => {
    const refused = extensionGroupRefusals([
      { id: "board", permissions: [], personalData: [], extends: [] },
      {
        id: "motions",
        permissions: [],
        personalData: ["name"],
        extends: [{ plugin: "board" }],
      },
      {
        id: "site",
        permissions: ["site:blocks"],
        personalData: [],
        extends: [{ plugin: "board" }],
      },
    ]);

    expect([...refused.keys()]).toEqual(["site"]);
  });

  it("reads published text and pictures as no reach into the register", () => {
    expect(
      extensionGroupRefusals([
        {
          id: "site",
          permissions: ["site:blocks"],
          personalData: [],
          extends: [],
        },
        {
          id: "gallery",
          permissions: ["media:read", "news:read"],
          personalData: ["freeText", "photograph"],
          extends: [{ plugin: "site" }],
        },
      ]).size,
    ).toBe(0);
  });

  describe("given members without the personal data they declare", () => {
    // What a caller written before the rule read declarations passes: it
    // still compiles, and is answered by the permissions alone.
    const site: ExtensionGroupMember = {
      id: "site",
      permissions: ["site:blocks"],
      extends: [],
    };

    it("reads a neutral addon beside a website host as reaching nothing", () => {
      const weather: ExtensionGroupMember = {
        id: "weather",
        permissions: [],
        extends: [{ plugin: "site" }],
      };

      expect(extensionGroupRefusals([site, weather]).size).toBe(0);
    });

    it("still refuses an addon that reads the address book beside it", () => {
      const residents: ExtensionGroupMember = {
        id: "residents",
        permissions: ["addressBook:read"],
        extends: [{ plugin: "site" }],
      };

      expect(extensionGroupRefusals([site, residents])).toEqual(
        new Map([
          ["residents", { website: ["site"], register: ["residents"] }],
        ]),
      );
    });
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

describe("the resident routes a manifest declares (ADR 0051)", () => {
  const OFFERS = { path: "offers", titleKey: "residentRoutes.offers" };
  const CLAIMS = { path: "claims", titleKey: "residentRoutes.claims" };

  function issues(overrides: Record<string, unknown>): string[] {
    const result = parsePluginPackage(
      manifest({
        permissions: ["addressBook:read"],
        residentRoutes: [OFFERS],
        ...overrides,
      }),
    );
    return result.ok ? [] : result.issues;
  }

  it("defaults to none and reads the declared routes", () => {
    const none = parsePluginPackage(manifest());
    expect(none.ok && none.value.openbrf.residentRoutes).toEqual([]);

    const declared = parsePluginPackage(
      manifest({
        permissions: ["addressBook:read"],
        residentRoutes: [OFFERS, CLAIMS],
        view: { titleKey: "view.title", section: "building" },
      }),
    );
    expect(declared.ok && declared.value.openbrf.residentRoutes).toEqual([
      OFFERS,
      CLAIMS,
    ]);
  });

  it("refuses a path that is not a route under the plugin's own mount", () => {
    for (const path of [
      "/offers",
      "offers/",
      "../core",
      "Offers",
      "a//b",
      "",
    ]) {
      expect(
        issues({ residentRoutes: [{ ...OFFERS, path }] }).join("\n"),
      ).toContain("residentRoutes.0.path");
    }
  });

  it("refuses a route without a title key", () => {
    expect(
      issues({ residentRoutes: [{ path: "offers" }] }).join("\n"),
    ).toContain("residentRoutes.0.titleKey");
    expect(
      issues({ residentRoutes: [{ ...OFFERS, titleKey: "" }] }).join("\n"),
    ).toContain("residentRoutes.0.titleKey");
  });

  it("refuses more than eight routes", () => {
    const routes = Array.from({ length: 9 }, (_, index) => ({
      path: `route-${String(index)}`,
      titleKey: `residentRoutes.route${String(index)}`,
    }));
    expect(issues({ residentRoutes: routes })).not.toEqual([]);
    expect(issues({ residentRoutes: routes.slice(0, 8) })).toEqual([]);
  });

  it("refuses one route inside another", () => {
    expect(
      issues({
        residentRoutes: [OFFERS, { ...CLAIMS, path: "offers/claims" }],
      }).join("\n"),
    ).toContain(
      'residentRoutes.1.path: the resident route "offers/claims" overlaps "offers"',
    );
    expect(issues({ residentRoutes: [OFFERS, OFFERS] }).join("\n")).toContain(
      "residentRoutes.1.path",
    );
    // A shared prefix of letters is not a shared path.
    expect(
      issues({ residentRoutes: [OFFERS, { ...CLAIMS, path: "offers-old" }] }),
    ).toEqual([]);
  });

  it("refuses a route that overlaps the OAuth protected resource, either way", () => {
    for (const [resource, path] of [
      ["mcp", "mcp"],
      ["mcp", "mcp/offers"],
      ["api/mcp", "api"],
    ] as const) {
      expect(
        issues({
          oauthProtectedResource: resource,
          residentRoutes: [{ ...OFFERS, path }],
        }).join("\n"),
      ).toContain(
        `residentRoutes.0.path: the resident route "${path}" overlaps the oauthProtectedResource "${resource}"`,
      );
    }
    expect(
      issues({ oauthProtectedResource: "mcp", residentRoutes: [OFFERS] }),
    ).toEqual([]);
  });

  it.each(["addressBook:read", "addressBook:readContact"])(
    "accepts the routes beside %s",
    (permission) => {
      expect(issues({ permissions: [permission] })).toEqual([]);
    },
  );

  it("refuses the routes from a plugin that does not read the address book", () => {
    // Without the permission every route already answers every account, and
    // the declaration would lower nothing. Proposing an import holds the
    // member list but reads nothing from the address book.
    for (const permissions of [
      [],
      ["mail:send", "jobs:schedule"],
      ["addressBook:proposeImport"],
    ]) {
      expect(issues({ permissions }).join("\n")).toContain(
        'permissions: a plugin that declares residentRoutes asks for "addressBook:read" or "addressBook:readContact"',
      );
    }
  });

  it.each(["finances:read", "finances:recordDelivery"])(
    "refuses the routes beside %s",
    (permission) => {
      expect(
        issues({ permissions: ["addressBook:read", permission] }).join("\n"),
      ).toContain(
        `permissions: a plugin that declares residentRoutes may not also ask for "${permission}"`,
      );
    },
  );

  it("refuses the routes beside a view in the board's section", () => {
    expect(
      issues({ view: { titleKey: "view.title", section: "board" } }).join("\n"),
    ).toContain("view.section: a plugin that declares residentRoutes");
  });

  it.each(PLUGIN_VIEW_SECTIONS.filter((section) => section !== "board"))(
    "accepts the routes beside a view in the %s section",
    (section) => {
      expect(issues({ view: { titleKey: "view.title", section } })).toEqual([]);
    },
  );

  it("accepts the routes beside a view in no section", () => {
    expect(issues({ view: { titleKey: "view.title" } })).toEqual([]);
  });

  it("refuses the routes beside an extension point, and allows them in an addon", () => {
    expect(
      issues({ extensionPoints: [{ id: "space-labels", version: 1 }] }).join(
        "\n",
      ),
    ).toContain(
      "extensionPoints: a plugin that declares residentRoutes declares no extension points",
    );
    // Its contribution runs in its host plugin's request, not on a resident
    // route.
    expect(
      issues({
        extends: [{ plugin: "digital-signage", point: "slides", version: 1 }],
      }),
    ).toEqual([]);
  });

  it("leaves device routes to their own rule, which refuses the address book", () => {
    const result = parsePluginPackage(
      manifest({
        permissions: ["addressBook:read"],
        residentRoutes: [OFFERS],
        deviceRoutes: [{ id: "screen", path: "screen" }],
      }),
    );

    expect(!result.ok && result.diagnostics.map(({ rule }) => rule)).toEqual([
      "device-route-reads-register",
    ]);
  });
});

describe("residentRouteRuleIssues", () => {
  const declaration = {
    residentRoutes: [{ path: "offers" }],
    permissions: ["addressBook:read"],
    extensionPoints: [],
  };

  it("finds nothing in a declaration within the rules", () => {
    expect(residentRouteRuleIssues(declaration)).toEqual([]);
  });

  it("holds a declaration with no resident routes to none of its rules", () => {
    // Every rule is about what a resident route may stand beside.
    expect(
      residentRouteRuleIssues({
        residentRoutes: [],
        oauthProtectedResource: "offers",
        permissions: ["finances:read"],
        extensionPoints: [{}],
        view: { section: "board" },
      }),
    ).toEqual([]);
  });

  it("reads an absent view as one outside the board's section", () => {
    // A catalog entry carries no view, and passes none.
    expect(
      residentRouteRuleIssues({ ...declaration, view: undefined }),
    ).toEqual([]);
    expect(residentRouteRuleIssues({ ...declaration, view: {} })).toEqual([]);
  });

  it("reports every rule a declaration breaks, each at its own path", () => {
    expect(
      residentRouteRuleIssues({
        residentRoutes: [{ path: "claims" }, { path: "mcp/offers" }],
        oauthProtectedResource: "mcp",
        permissions: ["finances:read", "finances:recordDelivery"],
        extensionPoints: [{}],
        view: { section: "board" },
      }).map(({ path }) => path),
    ).toEqual([
      ["residentRoutes", 1, "path"],
      ["permissions"],
      ["permissions"],
      ["view", "section"],
      ["extensionPoints"],
    ]);
  });

  it("names both finance permissions in one issue when both are asked for", () => {
    const [issue] = residentRouteRuleIssues({
      ...declaration,
      permissions: [
        "addressBook:read",
        "finances:read",
        "finances:recordDelivery",
      ],
    });

    expect(issue?.message).toContain(
      '"finances:read" or "finances:recordDelivery"',
    );
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
