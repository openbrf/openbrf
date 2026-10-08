import { describe, expect, it } from "vitest";

import {
  type Catalog,
  type CatalogPluginEntry,
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

  it("rejects an index whose version is not 1", () => {
    // The version exists so a future index shape is recognised and refused
    // rather than read with today's rules and partly misunderstood.
    refusal(index([pluginEntry()], 2));
    refusal(index([pluginEntry()], "1"));
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
