import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { PLUGIN_API_VERSION } from "./api-version.ts";
import { parsePluginPackage, processingDataSubjects } from "./manifest.ts";

/**
 * docs/parking-share-data-protection.md fixes the processing declaration and
 * the records about a person that the parking-share plugin copies into its
 * manifest, before the plugin is built. These tests read that page, so the
 * declaration it gives stays one the SDK accepts, and the record of processing
 * and the text keys it shows beside it stay the declaration's own.
 */

const page = readFileSync(
  new URL("../../../docs/parking-share-data-protection.md", import.meta.url),
  "utf8",
);

/** The text of a `## ` section, up to the next one. */
function section(heading: string): string {
  const start = page.indexOf(`\n## ${heading}\n`);
  if (start < 0) {
    throw new Error(`no section "${heading}"`);
  }
  const end = page.indexOf("\n## ", start + 1);
  return page.slice(start, end < 0 ? undefined : end);
}

/** The page's JSONC block, read as JSON once its trailing commas are gone. */
function declaredManifest(): Record<string, unknown> {
  const block = /```jsonc\n([\s\S]*?)\n```/.exec(
    section("The declaration for the manifest"),
  )?.[1];
  if (block === undefined) {
    throw new Error("no jsonc block under the declaration");
  }
  const json = JSON.parse(block.replaceAll(/,(\s*[}\]])/g, "$1")) as {
    openbrf: Record<string, unknown>;
  };
  return json.openbrf;
}

/** The cells of each row of the section's tables, keyed by the first cell. */
function tableRows(heading: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of section(heading).split("\n")) {
    if (!line.startsWith("| ") || /^\|\s*-+/.test(line)) {
      continue;
    }
    const cells = line
      .slice(1, -1)
      .split(" | ")
      .map((cell) => cell.trim());
    rows.set(cells[0] ?? "", cells.slice(1));
  }
  return rows;
}

const declared = declaredManifest();

function asPackage(): unknown {
  return {
    name: "@openbrf/parking-share",
    version: "1.0.0",
    openbrf: {
      apiVersion: PLUGIN_API_VERSION,
      entry: { server: "./dist/server.cjs", client: "./dist/remoteEntry.js" },
      // As the page's consent screen lists them.
      permissions: [
        "addressBook:read",
        "addressBook:readContact",
        "mail:send",
        "jobs:schedule",
      ],
      ...declared,
    },
  };
}

describe("the parking-share declaration in the docs", () => {
  it("is a manifest parsePluginPackage accepts, processing and records included", () => {
    const result = parsePluginPackage(asPackage());

    expect(result.ok ? [] : result.issues).toEqual([]);
    if (!result.ok) {
      return;
    }
    expect(result.value.openbrf.processing).toEqual(declared["processing"]);
    expect(
      result.value.openbrf.personRecords.map(
        ({ collection, personalData, keepAtMostDays }) => ({
          collection,
          personalData,
          keepAtMostDays,
        }),
      ),
    ).toEqual(
      (
        declared["personRecords"] as {
          collection: string;
          personalData: string[];
          keepAtMostDays: number;
        }[]
      ).map(({ collection, personalData, keepAtMostDays }) => ({
        collection,
        personalData,
        keepAtMostDays,
      })),
    );
  });

  it("is what the record of processing activities on the page says", () => {
    const rows = tableRows("The entry in the record of processing activities");
    const processing = declared["processing"] as Record<
      string,
      { sv: string; en: string } | undefined
    >;

    expect(rows.get("Purpose")).toEqual([
      processing["purpose"]?.sv,
      processing["purpose"]?.en,
    ]);
    expect(rows.get("Legitimate interest")).toEqual([
      processing["legitimateInterest"]?.sv,
      processing["legitimateInterest"]?.en,
    ]);
    expect(rows.get("Retention")).toEqual([
      processing["retention"]?.sv,
      processing["retention"]?.en,
    ]);
  });

  it("lists the personal data the declaration has", () => {
    const rows = tableRows("The entry in the record of processing activities");
    const result = parsePluginPackage(asPackage());
    if (!result.ok) {
      throw new Error("the declaration is not accepted");
    }
    const label = {
      name: ["Namn", "Name"],
      apartment: ["lägenhet", "apartment"],
      email: ["e-postadress", "email address"],
      freeText: ["fritext", "free text"],
    } as const;
    const sentence = (language: 0 | 1) => {
      const words = result.value.openbrf.personalData.map((category) => {
        const known = label[category as keyof typeof label];
        if (known === undefined) {
          throw new Error(`the page has no label for ${category}`);
        }
        return known[language];
      });
      const text = words.join(", ");
      return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
    };

    expect(rows.get("Personal data")).toEqual([sentence(0), sentence(1)]);
  });

  it("names the legal basis and data subjects the declaration has", () => {
    const rows = tableRows("The entry in the record of processing activities");
    const result = parsePluginPackage(asPackage());
    if (!result.ok) {
      throw new Error("the declaration is not accepted");
    }
    const { processing, personRecords } = result.value.openbrf;
    if (processing === undefined) {
      throw new Error("the declaration has no processing entry");
    }
    // The host adds former residents to a plugin that keeps records about a
    // person, so the page names what processingDataSubjects returns.
    const subjects = processingDataSubjects({ processing, personRecords });
    const named = {
      members: ["medlemmar", "members"],
      residents: ["boende", "residents"],
      formerResidents: ["tidigare boende", "former residents"],
    } as const;
    // "Members, residents and former residents." as a list of whole names, so
    // "residents" is not found inside "former residents".
    const names = (cell: string | undefined) =>
      (cell ?? "")
        .replace(/\.$/, "")
        .split(/, | och | and /)
        .map((name) => name.toLowerCase());
    const expected = (language: 0 | 1) =>
      subjects.map((subject) => named[subject][language]);

    expect(processing.legalBasis).toBe("legitimateInterest");
    expect(rows.get("Legal basis")).toEqual([
      "Berättigat intresse (art. 6.1 f).",
      "Legitimate interest (art. 6(1)(f)).",
    ]);
    const cells = rows.get("Data subjects");
    expect(names(cells?.[0])).toEqual(expected(0));
    expect(names(cells?.[1])).toEqual(expected(1));
  });

  it("gives each declared text key its Swedish and English text on the page", () => {
    const rows = tableRows("Text keys");
    // Kept here, apart from the declaration, so a key moved to another
    // existing key or a changed translation fails.
    const expected = new Map<string, readonly [string, string]>([
      [
        "records.assignments.title",
        ["Tilldelad parkeringsplats", "Assigned parking space"],
      ],
      ["records.assignments.space", ["Plats", "Space"]],
      [
        "records.offers.title",
        ["Erbjuden parkeringsplats", "Offered parking space"],
      ],
      ["records.offers.space", ["Plats", "Space"]],
      ["records.offers.from", ["Första dag", "First day"]],
      ["records.offers.to", ["Sista dag", "Last day"]],
      ["records.offers.status", ["Status", "Status"]],
      ["records.offers.named", ["Namnet visas", "Name shown"]],
      [
        "records.days.title",
        [
          "Dag för en erbjuden parkeringsplats",
          "Day of an offered parking space",
        ],
      ],
      ["records.days.space", ["Plats", "Space"]],
      ["records.days.day", ["Dag", "Day"]],
      [
        "records.claims.title",
        ["Tagen parkeringsplats", "Claimed parking space"],
      ],
      ["records.claims.space", ["Plats", "Space"]],
      ["records.claims.from", ["Första dag", "First day"]],
      ["records.claims.to", ["Sista dag", "Last day"]],
      ["records.claims.status", ["Status", "Status"]],
      ["records.claims.named", ["Namnet visas", "Name shown"]],
      [
        "records.wanted-ads.title",
        ["Efterlysning av parkeringsplats", "Wanted ad for a parking space"],
      ],
      ["records.wanted-ads.from", ["Första dag", "First day"]],
      ["records.wanted-ads.to", ["Sista dag", "Last day"]],
      ["records.wanted-ads.note", ["Meddelande", "Note"]],
      [
        "records.wanted-ads.named",
        ["Namn och lägenhet visas", "Name and apartment shown"],
      ],
      [
        "records.replies.title",
        [
          "Svar på en efterlysning av parkeringsplats",
          "Reply to a wanted ad for a parking space",
        ],
      ],
      ["records.replies.wantedAd", ["Efterlysning", "Wanted ad"]],
      ["records.replies.note", ["Meddelande", "Note"]],
      ["records.replies.named", ["Namnet visas", "Name shown"]],
    ]);
    const declaredKeys = (
      declared["personRecords"] as {
        titleKey: string;
        fields: { labelKey: string }[];
      }[]
    ).flatMap(({ titleKey, fields }) => [
      titleKey,
      ...fields.map(({ labelKey }) => labelKey),
    ]);

    expect(declaredKeys).toEqual([...expected.keys()]);
    for (const [key, cells] of expected) {
      expect({ key, cells: rows.get(`\`${key}\``) }).toEqual({ key, cells });
    }
  });
});
