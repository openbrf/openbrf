import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { PLUGIN_API_VERSION } from "./api-version.ts";
import { parsePluginPackage } from "./manifest.ts";

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

  it("names only text keys the page gives in both languages", () => {
    const rows = tableRows("Text keys");
    const keys = (
      declared["personRecords"] as {
        titleKey: string;
        fields: { labelKey: string }[];
      }[]
    ).flatMap(({ titleKey, fields }) => [
      titleKey,
      ...fields.map(({ labelKey }) => labelKey),
    ]);

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const [sv, en] = rows.get(`\`${key}\``) ?? [];
      expect({ key, sv: Boolean(sv), en: Boolean(en) }).toEqual({
        key,
        sv: true,
        en: true,
      });
    }
  });
});
