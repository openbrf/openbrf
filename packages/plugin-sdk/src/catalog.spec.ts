import { describe, expect, it } from "vite-plus/test";

import {
  type Catalog,
  type CatalogPluginEntry,
  type CatalogRefusal,
  type CatalogThemeEntry,
  parseCatalogIndex,
} from "./catalog.ts";

/**
 * The catalog index is data fetched from elsewhere and turned into a consent
 * screen. The invariant these tests protect is that an entry the instance does
 * not fully understand is never offered to a board: the consent screen's whole
 * job is to say precisely what is being agreed to, so a half-understood entry
 * has nothing truthful to show.
 */

const DIGEST = `sha512-${"A".repeat(86)}==`;

function pluginEntry(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "plugin",
    id: "occupancy",
    packageName: "@openbrf/occupancy",
    version: "1.4.0",
    name: { sv: "Belaggning", en: "Occupancy" },
    description: { sv: "Visar belaggning", en: "Shows occupancy" },
    artifact: {
      url: "https://catalog.example.test/occupancy-1.4.0.tgz",
      sha512: DIGEST,
    },
    apiVersion: 1,
    ...overrides,
  };
}

function themeEntry(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "theme",
    id: "nordic",
    version: "2.0.1",
    name: { sv: "Nordisk", en: "Nordic" },
    description: { sv: "Ljust tema", en: "A light theme" },
    artifact: {
      url: "https://catalog.example.test/theme-nordic-2.0.1.tgz",
      sha512: DIGEST,
      bytes: 40_960,
    },
    contract: "1.x",
    ...overrides,
  };
}

function index(entries: unknown[], version: unknown = 1): unknown {
  return { version, entries };
}

/** The parsed index; fails if the index is refused. */
function parsed(input: unknown): Catalog {
  const result = parseCatalogIndex(input);
  if (!result.ok) {
    throw new Error(
      `The index was expected to parse:\n  ${result.issues.join("\n  ")}`,
    );
  }
  return result.value;
}

/** The issues a refused index was reported with; fails if it was accepted. */
function refusal(input: unknown): readonly string[] {
  const result = parseCatalogIndex(input);
  if (result.ok) {
    throw new Error("The index was expected to be refused.");
  }
  expect(result.issues.length).toBeGreaterThan(0);
  return result.issues;
}

/**
 * The refusals a refused index carried beside its lines, one per line and
 * null for a field's own problem; fails if it was accepted.
 */
function refusals(input: unknown): (CatalogRefusal | null)[] {
  const result = parseCatalogIndex(input);
  if (result.ok) {
    throw new Error("The index was expected to be refused.");
  }
  expect(result.diagnostics.map((diagnostic) => diagnostic.issue)).toEqual(
    result.issues,
  );
  return result.diagnostics.map((diagnostic) => diagnostic.refusal);
}

function onlyPlugin(catalog: Catalog): CatalogPluginEntry {
  const entry = catalog.entries.find(
    (candidate) => candidate.type === "plugin",
  );
  if (entry === undefined || entry.type !== "plugin") {
    throw new Error("The parsed index has no plugin entry.");
  }
  return entry;
}

function onlyTheme(catalog: Catalog): CatalogThemeEntry {
  const entry = catalog.entries.find((candidate) => candidate.type === "theme");
  if (entry === undefined || entry.type !== "theme") {
    throw new Error("The parsed index has no theme entry.");
  }
  return entry;
}

describe("parseCatalogIndex", () => {
  it("accepts an index carrying a plugin and a theme", () => {
    const catalog = parsed(index([pluginEntry(), themeEntry()]));
    expect(catalog.entries).toHaveLength(2);
  });

  it("narrows each entry on its type", () => {
    // Plugins and themes share one index because the board browses one screen
    // per kind, not one source per kind. The discriminator is what lets the
    // installer for each kind read the fields only its kind has.
    const catalog = parsed(index([pluginEntry(), themeEntry()]));

    expect(onlyPlugin(catalog).apiVersion).toBe(1);
    expect(onlyPlugin(catalog).packageName).toBe("@openbrf/occupancy");
    expect(onlyTheme(catalog).contract).toBe("1.x");
  });

  it("accepts a theme entry that names no package", () => {
    // A theme is read out of its archive and never installed with npm, so
    // requiring a package name of it would make every theme author invent one.
    const theme = onlyTheme(parsed(index([themeEntry()])));

    expect(theme.id).toBe("nordic");
    expect("packageName" in theme).toBe(false);
  });

  it("keeps the theme an entry says it extends", () => {
    expect(
      onlyTheme(parsed(index([themeEntry({ extends: "porttavlan" })]))).extends,
    ).toBe("porttavlan");
  });

  it("rejects a plugin entry that names no package", () => {
    // The installer writes npm's dependency set from it, which keys on the
    // package name and not on the catalog id.
    const withoutPackage = Object.fromEntries(
      Object.entries(pluginEntry() as Record<string, unknown>).filter(
        ([field]) => field !== "packageName",
      ),
    );

    expect(refusal(index([withoutPackage]))).toContainEqual(
      expect.stringMatching(/^entries\.0\.packageName:/),
    );
  });

  it("refuses an index listing one id twice, across a plugin and a theme", () => {
    /*
     * An install looks its entry up by id and then refuses one of the wrong
     * type, so a theme sharing a plugin's id would make that plugin impossible
     * to install - and which of the two a board was offered would depend on the
     * order of the file.
     */
    const issues = refusal(
      index([pluginEntry(), themeEntry({ id: "occupancy" })]),
    );

    expect(issues).toEqual([
      expect.stringMatching(/^entries\.1\.id: "occupancy" is already the id/),
    ]);
  });

  it("refuses an index listing one plugin twice", () => {
    expect(
      refusal(index([pluginEntry(), pluginEntry({ version: "1.5.0" })])),
    ).toHaveLength(1);
  });

  it("defaults deprecated to false and the declaration lists to empty", () => {
    // An entry that declares nothing must read as "asks for nothing" on the
    // consent screen, never as "the declaration is missing".
    const plugin = onlyPlugin(parsed(index([pluginEntry()])));

    expect(plugin.deprecated).toBe(false);
    expect(plugin.permissions).toEqual([]);
    expect(plugin.personalData).toEqual([]);
  });

  it("keeps the declared permissions and personal data categories", () => {
    const plugin = onlyPlugin(
      parsed(
        index([
          pluginEntry({
            permissions: ["addressBook:read", "mail:send"],
            personalData: ["name", "apartment"],
            deprecated: true,
          }),
        ]),
      ),
    );

    expect(plugin.permissions).toEqual(["addressBook:read", "mail:send"]);
    expect(plugin.personalData).toEqual(["name", "apartment"]);
    expect(plugin.deprecated).toBe(true);
  });

  it("holds an entry that proposes imports to the manifest's declaration (ADR 0043)", () => {
    const carried = [
      "name",
      "apartment",
      "residency",
      "email",
      "phone",
      "personalIdentityNumber",
      "protected",
    ];
    const plugin = onlyPlugin(
      parsed(
        index([
          pluginEntry({
            permissions: ["addressBook:proposeImport"],
            personalData: carried,
          }),
        ]),
      ),
    );
    expect(plugin.personalData).toEqual(carried);

    // Without the categories the list carries, and the identity number
    // without the permission that carries it: the loader would refuse both.
    expect(
      refusal(
        index([
          pluginEntry({
            permissions: ["addressBook:proposeImport"],
            personalData: ["name"],
          }),
        ]),
      ),
    ).toEqual([expect.stringMatching(/^entries\.0\.personalData: /)]);
    refusal(index([pluginEntry({ personalData: ["personalIdentityNumber"] })]));
  });

  it("rejects an index whose version is neither 1 nor 2", () => {
    // The version exists so a future index shape is recognised and refused
    // rather than read with today's rules and partly misunderstood.
    refusal(index([pluginEntry()], 3));
    refusal(index([pluginEntry()], "1"));
    expect(parsed(index([pluginEntry()], 2)).version).toBe(2);
  });

  describe("device routes (ADR 0031)", () => {
    const routes = [{ id: "screen", path: "screen" }];

    it("reads them in version 2 of the index", () => {
      const plugin = onlyPlugin(
        parsed(index([pluginEntry({ deviceRoutes: routes })], 2)),
      );
      expect(plugin.deviceRoutes).toEqual(routes);
    });

    it("refuses them in version 1, even empty, as any unknown key is", () => {
      refusal(index([pluginEntry({ deviceRoutes: routes })], 1));
      refusal(index([pluginEntry({ deviceRoutes: [] })], 1));
    });

    it("refuses a route with a field the index does not define", () => {
      refusal(
        index(
          [
            pluginEntry({
              deviceRoutes: [{ ...routes[0], methods: ["POST"] }],
            }),
          ],
          2,
        ),
      );
    });

    it("refuses an entry the loader would refuse", () => {
      refusal(
        index(
          [
            pluginEntry({
              deviceRoutes: routes,
              permissions: ["addressBook:read"],
            }),
          ],
          2,
        ),
      );
      refusal(
        index(
          [
            pluginEntry({
              deviceRoutes: [{ id: "screen", path: "mcp/screen" }],
              oauthProtectedResource: "mcp",
            }),
          ],
          2,
        ),
      );
      refusal(
        index(
          [
            pluginEntry({
              deviceRoutes: [
                { id: "screen", path: "screen" },
                { id: "pictures", path: "screen/pictures" },
              ],
            }),
          ],
          2,
        ),
      );
    });
  });

  it("rejects the whole index when a single entry is malformed", () => {
    // Deliberate, and the most important assertion in this file. A board that
    // installs from an index which silently dropped an entry cannot tell that
    // from an entry that was delisted on purpose, and the two mean opposite
    // things - one is "not offered any more", the other is "we lost it".
    const withOneBadEntry = index([
      pluginEntry(),
      pluginEntry({ id: "broken", artifact: { url: "" } }),
      themeEntry(),
    ]);

    expect(parseCatalogIndex(withOneBadEntry).ok).toBe(false);
  });

  it("rejects an entry asking for a permission that does not exist", () => {
    // The consent screen renders the permission set. A permission this host
    // cannot name is a permission the board cannot be asked about.
    refusal(index([pluginEntry({ permissions: ["database:write"] })]));
  });

  it("rejects an entry declaring an unknown personal data category", () => {
    refusal(index([pluginEntry({ personalData: ["biometrics"] })]));
  });

  it("keeps the categories a plugin handles beyond the register, in a version 1 index", () => {
    /*
     * A wider list of values is not a new field, so it is not a new index
     * version: an index whose entries use only the register's five reads as it
     * did. An older instance refuses an entry naming one of these whatever the
     * version says, so a version 2 would only have it refuse every index as
     * well, the ones naming none of them included.
     */
    const plugin = onlyPlugin(
      parsed(index([pluginEntry({ personalData: ["name", "freeText"] })])),
    );

    expect(plugin.personalData).toEqual(["name", "freeText"]);
  });

  it.each(["personalIdentityNumber", "protected"])(
    "rejects an entry declaring %s, which no plugin can reach",
    (category) => {
      refusal(index([pluginEntry({ personalData: [category] })]));
    },
  );

  it("rejects an entry declaring two actions under one id", () => {
    /*
     * Refused at this boundary as well as at the manifest's, through the same
     * schema. The consent screen renders from here, and a pair sharing an id
     * is a declaration it cannot show truthfully: consent compares the set, so
     * a later version that only swaps the two over is agreed to without asking,
     * and arming - which stores the bare id - then names whichever one the
     * binder's Map happened to keep.
     */
    refusal(
      index([
        pluginEntry({
          actions: [
            { id: "summary", capability: "self:manage", effect: "read" },
            { id: "summary", capability: "site:manage", effect: "write" },
          ],
        }),
      ]),
    );
  });

  // The id becomes a URL segment, an i18n namespace, a database key and a
  // directory name, and the archive file name is built from it.
  it.each([
    ["../escape", "a parent segment"],
    ["with/slash", "a slash"],
    ["with.dot", "a dot"],
    ["UPPER", "uppercase"],
    ["", "an empty id"],
  ])("rejects the entry id %j (%s)", (id) => {
    refusal(index([pluginEntry({ id })]));
    refusal(index([themeEntry({ id })]));
  });

  it("rejects an entry with an unknown type", () => {
    refusal(index([pluginEntry({ type: "widget" })]));
  });

  it("rejects an entry missing its artifact digest", () => {
    refusal(
      index([
        pluginEntry({
          artifact: { url: "https://catalog.example.test/a.tgz" },
        }),
      ]),
    );
  });

  it.each([
    ["the subresource-integrity spelling", DIGEST],
    ["the hex spelling", "a".repeat(128)],
  ])("accepts an artifact digest in %s", (_label, sha512) => {
    const entry = onlyPlugin(
      parsed(
        index([
          pluginEntry({
            artifact: { url: "https://catalog.example.test/a.tgz", sha512 },
          }),
        ]),
      ),
    );

    expect(entry.artifact.sha512).toBe(sha512);
  });

  it.each([
    ["a bare word", "not-a-digest"],
    ["a sha256 prefix", `sha256-${"A".repeat(43)}=`],
    ["a base64 digest that is not 64 bytes", `sha512-${"A".repeat(42)}==`],
    ["hex one character short", "a".repeat(127)],
  ])(
    "refuses an artifact digest that is %s, naming the field",
    (_label, sha512) => {
      // The index is refused here rather than at install time, where the same
      // entry would be reported as a download that does not match.
      const issues = refusal(
        index([
          pluginEntry({
            artifact: { url: "https://catalog.example.test/a.tgz", sha512 },
          }),
        ]),
      );

      expect(issues.join("\n")).toContain("entries.0.artifact.sha512");
    },
  );

  it("rejects a name that is not localized into both languages", () => {
    refusal(index([pluginEntry({ name: { en: "Occupancy" } })]));
    refusal(index([themeEntry({ name: "Nordic" })]));
  });

  it("keeps the protected resource route a connector declares", () => {
    /*
     * Carried through the index because both rules about it are decided before
     * anything is downloaded: a second plugin declaring one is refused at
     * install, and the reserved id may be taken only by a plugin that declares
     * one. Dropped here, both refusals would have nothing to read and would
     * never fire.
     */
    const plugin = onlyPlugin(
      parsed(index([pluginEntry({ oauthProtectedResource: "mcp/stream" })])),
    );

    expect(plugin.oauthProtectedResource).toBe("mcp/stream");
  });

  it("leaves the protected resource unset on an entry that declares none", () => {
    // Most plugins are not connectors, and "declares none" has to be
    // distinguishable from "declares something", because that is the whole of
    // what both install gates turn on.
    expect(
      onlyPlugin(parsed(index([pluginEntry()]))).oauthProtectedResource,
    ).toBeUndefined();
  });

  it("keeps an entry's declaration that it is an AI package", () => {
    // Carried through the index because the consent screen states it and the
    // install echo compares it, both before anything is downloaded.
    expect(onlyPlugin(parsed(index([pluginEntry({ ai: true })]))).ai).toBe(
      true,
    );
  });

  it("reads an entry that says nothing about ai as no AI package", () => {
    // So an index that lists no AI package need not carry the field, and stays
    // one an instance from before it can read.
    expect(onlyPlugin(parsed(index([pluginEntry()]))).ai).toBe(false);
  });

  it("refuses ai written as anything but a yes or a no", () => {
    refusal(index([pluginEntry({ ai: "ai" })]));
  });

  describe("the licence a paid plugin reads", () => {
    const LICENCE = {
      entitlement: "mcp-connector",
      issuer: { name: "Example AB", url: "https://licence.example.org" },
      keys: { "example-2026-1": `${"A".repeat(42)}A=` },
      audiences: ["https://gateway.example.org"],
    };

    it("keeps the declaration and the release date", () => {
      // The consent screen states the audiences and the install echo compares
      // them, both before anything is downloaded.
      const entry = onlyPlugin(
        parsed(
          index([pluginEntry({ licence: LICENCE, released: "2026-12-01" })]),
        ),
      );
      expect(entry.licence).toEqual(LICENCE);
      expect(entry.released).toBe("2026-12-01");
    });

    it("reads an entry that names no licence as a plugin that reads none", () => {
      const entry = onlyPlugin(parsed(index([pluginEntry()])));
      expect(entry.licence).toBeUndefined();
      expect(entry.released).toBeUndefined();
    });

    it("refuses a licence without the day the release was published", () => {
      // Without it the update screen could not say that a release falls
      // outside the licence's updates.
      expect(
        refusal(index([pluginEntry({ licence: LICENCE })])).join("\n"),
      ).toContain("released");
    });

    it("refuses a field the declaration does not define", () => {
      // Dropped, a misspelled audience list would read as none, and the board
      // would consent to a plugin whose manifest presents the licence anyway.
      refusal(
        index([
          pluginEntry({
            licence: { ...LICENCE, audience: ["https://other.example.org"] },
            released: "2026-12-01",
          }),
        ]),
      );
    });

    it("refuses an audience that is not a canonical https origin", () => {
      refusal(
        index([
          pluginEntry({
            licence: { ...LICENCE, audiences: ["http://gateway.example.org"] },
            released: "2026-12-01",
          }),
        ]),
      );
    });
  });

  // The value is joined onto the plugin's own mount and becomes a URL an
  // unauthenticated caller is pointed at, so what it may contain is settled by
  // the schema rather than by whoever joins it.
  it.each([
    ["/mcp", "a leading slash"],
    ["mcp/", "a trailing slash"],
    ["../mcp", "a parent segment"],
    ["MCP", "uppercase"],
    ["", "an empty route"],
  ])("rejects the protected resource route %j (%s)", (route) => {
    refusal(index([pluginEntry({ oauthProtectedResource: route })]));
  });

  /*
   * The index is versioned, and an index carrying anything this version cannot
   * read is refused whole. A field this version does not define is such a
   * thing: read loosely it would be dropped, and a misspelled field of the
   * declaration would be replaced by its default before the consent screen or
   * any manifest check saw it. A new field is a new index version.
   */
  describe("a field this version of the index does not define", () => {
    it("is refused at the top of the index", () => {
      expect(
        refusal({ version: 1, entries: [], signature: "abc" }),
      ).toContainEqual(expect.stringMatching(/^\(root\): .*"signature"/));
    });

    it("is refused in a plugin entry", () => {
      expect(
        refusal(index([pluginEntry({ publisher: "Example AB" })])),
      ).toContainEqual(expect.stringMatching(/^entries\.0: .*"publisher"/));
    });

    it("is refused in a theme entry", () => {
      expect(
        refusal(index([themeEntry({ packageName: "@openbrf/theme-nordic" })])),
      ).toContainEqual(expect.stringMatching(/^entries\.0: .*"packageName"/));
    });

    it("is refused in an artifact", () => {
      expect(
        refusal(
          index([
            pluginEntry({
              artifact: {
                url: "https://catalog.example.test/a.tgz",
                sha512: DIGEST,
                sha256: "abc",
              },
            }),
          ]),
        ),
      ).toContainEqual(
        expect.stringMatching(/^entries\.0\.artifact: .*"sha256"/),
      );
    });

    it("is refused in a localized text", () => {
      refusal(
        index([
          pluginEntry({
            name: { sv: "Belaggning", en: "Occupancy", de: "Belegung" },
          }),
        ]),
      );
    });

    it("is refused in an action declaration", () => {
      // `surface` for `surfaces`: read loosely, the action would be offered
      // on the default surface rather than refused.
      expect(
        refusal(
          index([
            pluginEntry({
              actions: [
                {
                  id: "summary",
                  capability: "addressBook:read",
                  effect: "read",
                  surface: ["mcp"],
                },
              ],
            }),
          ]),
        ),
      ).toContainEqual(
        expect.stringMatching(/^entries\.0\.actions\.0: .*"surface"/),
      );
    });

    it("refuses a misspelled consent field rather than defaulting it", () => {
      // Read loosely, `permisions` would be dropped and `permissions` would
      // default to none: a consent screen stating that the plugin asks for
      // nothing, for a plugin whose manifest asks for the address book.
      expect(
        refusal(index([pluginEntry({ permisions: ["addressBook:read"] })])),
      ).toContainEqual(expect.stringMatching(/^entries\.0: .*"permisions"/));
    });
  });

  it("accepts an index with no entries at all", () => {
    // A catalog that has delisted everything is well-formed and says so.
    expect(parsed(index([])).entries).toEqual([]);
  });

  it("names the offending field in each issue", () => {
    // The issues are for a person reading a log or a catalog check's output,
    // so each one says where in the file the problem is.
    expect(refusal(index([pluginEntry({ id: "../escape" })]))).toContainEqual(
      expect.stringMatching(/^entries\.0\.id: /),
    );
  });
});

describe("the recipients a plugin entry declares", () => {
  const recipient = {
    id: "model-provider",
    origin: "https://api.anthropic.com",
    purpose: { sv: "Språkmodellen", en: "The language model" },
    personalData: ["freeText"],
  };

  it("keeps them in a version 2 index", () => {
    const entry = onlyPlugin(
      parsed(
        index(
          [
            pluginEntry({
              personalData: ["freeText"],
              recipients: [recipient],
            }),
          ],
          2,
        ),
      ),
    );
    expect(entry.recipients).toEqual([recipient]);
  });

  // The manifest's rule, so the consent screen never names a category the
  // plugin does not declare it handles.
  it("refuses a category the entry's own personalData lacks", () => {
    expect(
      refusal(
        index([pluginEntry({ personalData: [], recipients: [recipient] })], 2),
      ),
    ).toContainEqual(
      expect.stringMatching(/^entries\.0\.recipients\.0\.personalData\.0: /),
    );
  });

  // A field is in the version that defines it. An instance reading only
  // version 1 refuses the entry, so an index claiming version 1 cannot carry
  // it.
  it("refuses them in a version 1 index, even when there are none", () => {
    expect(
      refusal(index([pluginEntry({ recipients: [recipient] })], 1)),
    ).toContainEqual(expect.stringMatching(/^entries\.0\.recipients: /));
    refusal(index([pluginEntry({ recipients: [] })], 1));
  });

  // The two rules do not hide each other: a version 1 entry that also names a
  // category it does not handle is told both.
  it("tells a version 1 entry's recipients and their category apart", () => {
    const issues = refusal(
      index([pluginEntry({ personalData: [], recipients: [recipient] })], 1),
    );
    expect(issues).toContainEqual(
      expect.stringMatching(/^entries\.0\.recipients: /),
    );
    expect(issues).toContainEqual(
      expect.stringMatching(/^entries\.0\.recipients\.0\.personalData\.0: /),
    );
  });

  it("leaves them unset on an entry that declares none", () => {
    expect(onlyPlugin(parsed(index([pluginEntry()], 2))).recipients).toBe(
      undefined,
    );
  });

  // Strict, as everything in the index is: a misspelled field of a recipient
  // would otherwise be dropped before the consent screen showed it.
  it("refuses a field a recipient does not define", () => {
    refusal(
      index(
        [
          pluginEntry({
            personalData: ["freeText"],
            recipients: [{ ...recipient, personaldata: [] }],
          }),
        ],
        2,
      ),
    );
  });

  it("refuses an origin that is not https", () => {
    refusal(
      index(
        [
          pluginEntry({
            personalData: ["freeText"],
            recipients: [{ ...recipient, origin: "http://api.anthropic.com" }],
          }),
        ],
        2,
      ),
    );
  });
});

/**
 * Version 2 of the index, which carries the extension declarations of ADR
 * 0030 so the consent screens can say what a plugin offers and what an addon
 * extends before anything is downloaded.
 */
describe("parseCatalogIndex, version 2", () => {
  const point = {
    id: "source",
    version: 1,
    personalData: ["name"],
    title: { sv: "Källa", en: "Source" },
    description: {
      sv: "Något som visas på skärmen",
      en: "Something the screen shows",
    },
  };
  const extendsSource = {
    plugin: "signage",
    point: "source",
    version: 1,
    personalData: ["name"],
  };

  it("reads a host plugin's points with the curator's text", () => {
    const plugin = onlyPlugin(
      parsed(
        index(
          [
            pluginEntry({
              id: "signage",
              personalData: ["name"],
              extensionPoints: [point],
            }),
          ],
          2,
        ),
      ),
    );

    expect(plugin.extensionPoints).toEqual([point]);
    expect(plugin.extends).toBeUndefined();
  });

  it("reads what an addon extends", () => {
    const plugin = onlyPlugin(
      parsed(
        index(
          [pluginEntry({ personalData: ["name"], extends: [extendsSource] })],
          2,
        ),
      ),
    );

    expect(plugin.extends).toEqual([extendsSource]);
  });

  it("reads a version 1 entry unchanged", () => {
    expect(onlyPlugin(parsed(index([pluginEntry()], 2))).extends).toBe(
      undefined,
    );
  });

  it.each(["extensionPoints", "extends"])(
    "refuses %s in version 1, even empty",
    (field) => {
      // An instance that reads only version 1 refuses the key as unknown, so
      // this one has to read the same index the same way.
      expect(refusal(index([pluginEntry({ [field]: [] })]))).toContainEqual(
        `entries.0.${field}: ${field} needs version 2 of the index`,
      );
    },
  );

  it("refuses a point without the curator's text", () => {
    expect(
      refusal(
        index(
          [
            pluginEntry({
              personalData: ["name"],
              extensionPoints: [
                { id: "source", version: 1, personalData: ["name"] },
              ],
            }),
          ],
          2,
        ),
      ),
    ).toContainEqual(
      expect.stringMatching(/^entries\.0\.extensionPoints\.0\.title/),
    );
  });

  it("refuses a field a point does not define", () => {
    expect(
      refusal(
        index(
          [pluginEntry({ extensionPoints: [{ ...point, schema: "./x" }] })],
          2,
        ),
      ),
    ).toContainEqual(expect.stringMatching(/"schema"/));
  });

  it("holds an entry to the manifest's rules", () => {
    // The loader would refuse this package, so it is never offered for
    // consent: the addon hands over a name it does not declare handling.
    expect(
      refusal(index([pluginEntry({ extends: [extendsSource] })], 2)),
    ).toContainEqual(
      "entries.0.extends.0.personalData: name must be among the plugin's own personalData",
    );
  });

  describe("an addon to a plugin whose points cannot serve it", () => {
    const host = (personalData: string[], version = 1): unknown =>
      pluginEntry({
        id: "signage",
        personalData: ["name"],
        extensionPoints: [{ ...point, version, personalData }],
      });
    const addon = (extension: Record<string, unknown>): unknown =>
      pluginEntry({
        id: "signage-residents",
        personalData: ["name"],
        extends: [{ ...extendsSource, ...extension }],
      });

    it("refuses one that extends a point the plugin does not declare", () => {
      expect(
        refusal(index([host(["name"]), addon({ point: "display" })], 2)),
      ).toEqual([
        'entries.1.extends.0.point: signage declares no extension point "display"',
      ]);
      expect(
        refusals(index([host(["name"]), addon({ point: "display" })], 2)),
      ).toEqual([
        {
          code: "extension-point-unknown",
          detail: {
            addon: "signage-residents",
            plugin: "signage",
            point: "display",
          },
        },
      ]);
    });

    it("refuses one written for another version of the point", () => {
      expect(refusal(index([host(["name"], 2), addon({})], 2))).toEqual([
        'entries.1.extends.0.version: "source" of signage is at version 2, not 1',
      ]);
      expect(refusals(index([host(["name"], 2), addon({})], 2))).toEqual([
        {
          code: "extension-version-unsupported",
          detail: {
            addon: "signage-residents",
            plugin: "signage",
            point: "source",
            version: 1,
            supported: 2,
          },
        },
      ]);
    });

    it("refuses one that hands over what the point does not accept", () => {
      expect(refusal(index([host([]), addon({})], 2))).toEqual([
        'entries.1.extends.0.personalData: "source" of signage does not accept name',
      ]);
      expect(refusals(index([host([]), addon({})], 2))).toEqual([
        {
          code: "extension-personal-data-refused",
          detail: {
            addon: "signage-residents",
            plugin: "signage",
            point: "source",
            categories: ["name"],
          },
        },
      ]);
    });

    it("carries no refusal for a field's own problem", () => {
      expect(
        refusals(index([pluginEntry({ id: "Signage" }), addon({})], 2)),
      ).toEqual([null]);
    });

    it("reads one the point serves, wherever the index lists it", () => {
      expect(
        parsed(index([host(["name"]), addon({})], 2)).entries,
      ).toHaveLength(2);
      expect(
        parsed(index([addon({}), host(["name"])], 2)).entries,
      ).toHaveLength(2);
    });
  });

  describe("an addon to a plugin that puts blocks on the website", () => {
    const websiteSource = { ...point, personalData: [] };
    const website = pluginEntry({
      id: "signage",
      permissions: ["site:blocks"],
      extensionPoints: [websiteSource],
    });
    const addonEntry = (permissions: string[]): unknown =>
      pluginEntry({
        id: "signage-residents",
        permissions,
        personalData: ["name"],
        extends: [{ ...extendsSource, personalData: [] }],
      });

    it("refuses one that reads the address book", () => {
      // It declares handing over nothing, and the declaration is all that
      // would stand between the register and the public page.
      expect(
        refusal(index([website, addonEntry(["addressBook:read"])], 2)),
      ).toContainEqual(
        'entries.1.extends.0.plugin: signage asks for "site:blocks", so a plugin that extends it may not read the address book: addressBook:read',
      );
      expect(
        refusals(index([website, addonEntry(["addressBook:read"])], 2)),
      ).toContainEqual({
        code: "extension-permission-refused",
        detail: {
          addon: "signage-residents",
          plugin: "signage",
          point: "source",
          permissions: ["addressBook:read"],
        },
      });
    });

    it("reads one that does not", () => {
      expect(
        parsed(index([website, addonEntry(["mail:send"])], 2)).entries,
      ).toHaveLength(2);
    });
  });

  describe("a website addon to a plugin that reads the address book", () => {
    const readerEntry = (permissions: string[]): unknown =>
      pluginEntry({
        id: "signage",
        permissions,
        extensionPoints: [{ ...point, personalData: [] }],
      });
    const websiteAddon = pluginEntry({
      id: "signage-website",
      permissions: ["site:blocks"],
      personalData: [],
      extends: [{ ...extendsSource, personalData: [] }],
    });

    it("refuses it", () => {
      // The addon hands over nothing, but the point's input could carry the
      // names it renders on the public page.
      expect(
        refusal(index([readerEntry(["addressBook:read"]), websiteAddon], 2)),
      ).toContainEqual(
        'entries.1.extends.0.plugin: signage reads the address book, so a plugin that asks for "site:blocks" may not extend it: addressBook:read',
      );
    });

    it("refuses it to one that handles personal data", () => {
      // Another addon could hand that plugin names, and it could hand them on
      // as the point's input.
      expect(
        refusal(
          index(
            [
              pluginEntry({
                id: "signage",
                permissions: ["mail:send"],
                personalData: ["name"],
                extensionPoints: [point],
              }),
              websiteAddon,
            ],
            2,
          ),
        ),
      ).toContainEqual(
        'entries.1.extends.0.plugin: signage handles personal data, so a plugin that asks for "site:blocks" may not extend it: name',
      );
      expect(
        refusals(
          index(
            [
              pluginEntry({
                id: "signage",
                permissions: ["mail:send"],
                personalData: ["name"],
                extensionPoints: [point],
              }),
              websiteAddon,
            ],
            2,
          ),
        ),
      ).toContainEqual({
        code: "extension-host-personal-data-refused",
        detail: {
          addon: "signage-website",
          plugin: "signage",
          point: "source",
          categories: ["name"],
        },
      });
    });

    it("reads it beside one that does neither", () => {
      expect(
        parsed(index([readerEntry(["mail:send"]), websiteAddon], 2)).entries,
      ).toHaveLength(2);
    });
  });

  describe("a website addon and one that reads the address book, on one host plugin", () => {
    // The host plugin reads nothing and handles nothing, so each addon passes
    // the rule beside it.
    const host = pluginEntry({
      id: "signage",
      extensionPoints: [
        { ...point, personalData: [] },
        { ...point, id: "display", personalData: [] },
      ],
    });
    const residents = pluginEntry({
      id: "signage-residents",
      permissions: ["addressBook:read"],
      personalData: ["name"],
      extends: [{ ...extendsSource, personalData: [] }],
    });
    const website = pluginEntry({
      id: "signage-website",
      permissions: ["site:blocks"],
      extends: [{ ...extendsSource, point: "display", personalData: [] }],
    });

    it("refuses the website addon, wherever the index lists it", () => {
      // The addon reading the register hands the host plugin a name while
      // declaring nothing, and the host plugin hands it to the website addon.
      expect(refusal(index([host, residents, website], 2))).toEqual([
        'entries.2.extends: the plugins it is joined to by extensions would hold one that asks for "site:blocks" (signage-website) and one that reads the address book (signage-residents)',
      ]);
      expect(refusal(index([website, host, residents], 2))).toEqual([
        'entries.0.extends: the plugins it is joined to by extensions would hold one that asks for "site:blocks" (signage-website) and one that reads the address book (signage-residents)',
      ]);
      expect(refusals(index([host, residents, website], 2))).toEqual([
        {
          code: "extension-group-refused",
          detail: {
            addon: "signage-website",
            website: ["signage-website"],
            register: ["signage-residents"],
          },
        },
      ]);
    });

    it("reads either addon beside the host plugin alone", () => {
      expect(parsed(index([host, residents], 2)).entries).toHaveLength(2);
      expect(parsed(index([host, website], 2)).entries).toHaveLength(2);
    });
  });
});
