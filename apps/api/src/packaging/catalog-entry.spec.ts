import { describe, expect, it } from "vitest";

import {
  type Catalog,
  CatalogError,
  type CatalogPluginEntry,
  type CatalogThemeEntry,
  parseCatalog,
} from "./catalog-entry";

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
    packageName: "@openbrf/theme-nordic",
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

/** The reason of the CatalogError a parse raises; fails if it raises none. */
function refusalReason(input: unknown): string {
  try {
    parseCatalog(input);
  } catch (error) {
    if (error instanceof CatalogError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error("The index was expected to be refused.");
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

describe("parseCatalog", () => {
  it("accepts an index carrying a plugin and a theme", () => {
    const catalog = parseCatalog(index([pluginEntry(), themeEntry()]));
    expect(catalog.entries).toHaveLength(2);
  });

  it("narrows each entry on its type", () => {
    // Plugins and themes share one index because the board browses one screen
    // per kind, not one source per kind. The discriminator is what lets the
    // installer for each kind read the fields only its kind has.
    const catalog = parseCatalog(index([pluginEntry(), themeEntry()]));

    expect(onlyPlugin(catalog).apiVersion).toBe(1);
    expect(onlyTheme(catalog).contract).toBe("1.x");
  });

  it("defaults deprecated to false and the declaration lists to empty", () => {
    // An entry that declares nothing must read as "asks for nothing" on the
    // consent screen, never as "the declaration is missing".
    const plugin = onlyPlugin(parseCatalog(index([pluginEntry()])));

    expect(plugin.deprecated).toBe(false);
    expect(plugin.permissions).toEqual([]);
    expect(plugin.personalData).toEqual([]);
  });

  it("keeps the declared permissions and personal data categories", () => {
    const plugin = onlyPlugin(
      parseCatalog(
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
    expect(refusalReason(index([pluginEntry()], 2))).toBe("catalog-malformed");
    expect(refusalReason(index([pluginEntry()], "1"))).toBe(
      "catalog-malformed",
    );
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

    expect(refusalReason(withOneBadEntry)).toBe("catalog-malformed");
    expect(() => parseCatalog(withOneBadEntry)).toThrow(CatalogError);
  });

  it("rejects an entry asking for a permission that does not exist", () => {
    // The consent screen renders the permission set. A permission this host
    // cannot name is a permission the board cannot be asked about.
    expect(
      refusalReason(index([pluginEntry({ permissions: ["database:write"] })])),
    ).toBe("catalog-malformed");
  });

  it("rejects an entry declaring an unknown personal data category", () => {
    expect(
      refusalReason(index([pluginEntry({ personalData: ["biometrics"] })])),
    ).toBe("catalog-malformed");
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
    expect(refusalReason(index([pluginEntry({ id })]))).toBe(
      "catalog-malformed",
    );
  });

  it("rejects an entry with an unknown type", () => {
    expect(refusalReason(index([pluginEntry({ type: "widget" })]))).toBe(
      "catalog-malformed",
    );
  });

  it("rejects an entry missing its artifact digest", () => {
    expect(
      refusalReason(
        index([
          pluginEntry({
            artifact: { url: "https://catalog.example.test/a.tgz" },
          }),
        ]),
      ),
    ).toBe("catalog-malformed");
  });

  it("rejects a name that is not localized into both languages", () => {
    expect(
      refusalReason(index([pluginEntry({ name: { en: "Occupancy" } })])),
    ).toBe("catalog-malformed");
  });

  it("accepts an index with no entries at all", () => {
    // A catalog that has delisted everything is well-formed and says so.
    expect(parseCatalog(index([])).entries).toEqual([]);
  });

  it("names the offending field in the message", () => {
    // The message is for the operator reading a log, not for a branch: the
    // reason above is what the installer decides on.
    expect(() =>
      parseCatalog(index([pluginEntry({ id: "../escape" })])),
    ).toThrow(/entries\.0\.id/);
  });
});
