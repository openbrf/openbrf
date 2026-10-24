import { beforeAll, describe, expect, it } from "vite-plus/test";

import { FALLBACK_LOCALE, I18nService } from "../i18n/i18n.service";
import { CatalogError, parseCatalog } from "../packaging/catalog-entry";
import { catalogErrorLines } from "./catalog-error-lines";

/**
 * What `openbrf` prints when the catalog cannot be read.
 *
 * The catalog screen's sentence, from the same translations, and for an addon
 * the index lists beside a host plugin that cannot serve it, the refusal in a
 * sentence of its own with the curator's English line beneath.
 */

const i18n = new I18nService();

beforeAll(async () => {
  await i18n.init();
});

const DIGEST = `sha512-${"A".repeat(86)}==`;

function pluginEntry(overrides: Record<string, unknown>): unknown {
  return {
    type: "plugin",
    packageName: `@openbrf/${String(overrides["id"])}`,
    version: "1.0.0",
    name: { sv: "Tillägg", en: "Plugin" },
    description: { sv: "Ett tillägg", en: "A plugin" },
    artifact: {
      url: "https://catalog.example.test/plugin.tgz",
      sha512: DIGEST,
    },
    apiVersion: 1,
    ...overrides,
  };
}

const point = {
  id: "source",
  version: 1,
  personalData: ["name"],
  title: { sv: "Källa", en: "Source" },
  description: { sv: "Något skärmen visar", en: "Something the screen shows" },
};

// What an entry that declares personal data declares in version 2 (ADR 0035),
// so the refusals under test are the only ones the index makes.
const processing = {
  purpose: { sv: "Visa tavlan", en: "Show the board" },
  legalBasis: "contract",
  retention: { sv: "Sparas inte.", en: "Not kept." },
  dataSubjects: ["members"],
};

function host(pointOverrides: Record<string, unknown>): unknown {
  return pluginEntry({
    id: "signage",
    personalData: ["name"],
    processing,
    extensionPoints: [{ ...point, ...pointOverrides }],
  });
}

function addon(extensionOverrides: Record<string, unknown>): unknown {
  return pluginEntry({
    id: "signage-residents",
    personalData: ["name"],
    processing,
    extends: [
      {
        plugin: "signage",
        point: "source",
        version: 1,
        personalData: ["name"],
        ...extensionOverrides,
      },
    ],
  });
}

function refusal(entries: unknown[]): CatalogError {
  try {
    parseCatalog({ version: 2, entries });
  } catch (error) {
    if (error instanceof CatalogError) {
      return error;
    }
    throw error;
  }
  throw new Error("The index was expected to be refused.");
}

describe("catalogErrorLines", () => {
  const t = () => i18n.translatorFor(FALLBACK_LOCALE);
  const malformed =
    "The catalog was reached but could not be read. It may be damaged or written for a newer version.";

  it("says which point the host plugin does not offer", () => {
    expect(
      catalogErrorLines(refusal([host({}), addon({ point: "display" })]), t()),
    ).toEqual([
      malformed,
      "  signage-residents extends display in signage, which that plugin does not offer.",
      '    entries.1.extends.0.point: signage declares no extension point "display"',
    ]);
  });

  it("says which version of the point the host plugin offers", () => {
    expect(
      catalogErrorLines(refusal([host({ version: 2 }), addon({})]), t()),
    ).toEqual([
      malformed,
      "  signage-residents is written for version 1 of source in signage, and the signage the catalog lists offers version 2.",
      '    entries.1.extends.0.version: "source" of signage is at version 2, not 1',
    ]);
  });

  it("names the refused categories as the consent screen does", () => {
    expect(
      catalogErrorLines(refusal([host({ personalData: [] }), addon({})]), t()),
    ).toEqual([
      malformed,
      "  signage-residents hands signage Name at source, which that point does not accept.",
      '    entries.1.extends.0.personalData: "source" of signage does not accept name',
    ]);
  });

  it("says it in the reader's language", () => {
    expect(
      catalogErrorLines(
        refusal([host({ personalData: [] }), addon({})]),
        i18n.translatorFor("sv"),
      ).slice(0, 2),
    ).toEqual([
      "Katalogen nåddes men kunde inte läsas. Den kan vara skadad eller skriven för en nyare version.",
      "  signage-residents lämnar Namn till signage vid source, och den utökningspunkten tar inte emot det.",
    ]);
  });

  it("prints a field's own problem as the line alone", () => {
    expect(
      catalogErrorLines(
        refusal([pluginEntry({ id: "Signage", personalData: [] })]),
        t(),
      ),
    ).toEqual([malformed, expect.stringMatching(/^ {2}entries\.0\.id: /)]);
  });

  it("prints what was thrown beneath an error with no lines of its own", () => {
    expect(
      catalogErrorLines(
        new CatalogError(
          "The catalog at https://catalog.example.test/index.json could not be reached.",
          "catalog-unreachable",
        ),
        t(),
      ),
    ).toEqual([
      "The catalog could not be reached. Check the instance's network access and the catalog address.",
      "  The catalog at https://catalog.example.test/index.json could not be reached.",
    ]);
  });
});
