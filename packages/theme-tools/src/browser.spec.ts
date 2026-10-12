import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as browserEntry from "./browser.ts";
import * as nodeEntry from "./index.ts";

/**
 * The web application imports this package, and a bundler that resolves the
 * `browser` condition gives it browser.ts. One import of a node: module
 * anywhere below that entry and the Vite development server serves a blank
 * page: the module is replaced by an empty stub, and a named import from the
 * stub fails when the module graph is linked, before anything renders. The
 * production build only warns, so nothing else would notice.
 */

const sourceDir = dirname(fileURLToPath(import.meta.url));

/** Every specifier a module imports or re-exports from, statically or not. */
function importedSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? "");
}

/** The modules reachable from `entry` and what each of them imports. */
function moduleGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (graph.has(file)) continue;
    const specifiers = importedSpecifiers(
      readFileSync(join(sourceDir, file), "utf8"),
    );
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith("./")) pending.push(specifier.slice(2));
    }
  }
  return graph;
}

describe("the browser entry", () => {
  it("reaches no node: module", () => {
    const nodeImports = [...moduleGraph("browser.ts")].flatMap(
      ([file, specifiers]) =>
        specifiers
          .filter((specifier) => specifier.startsWith("node:"))
          .map((specifier) => `${file} imports ${specifier}`),
    );
    expect(nodeImports).toEqual([]);
  });

  it("is what a bundler resolving the browser condition loads", () => {
    const manifest = JSON.parse(
      readFileSync(join(sourceDir, "..", "package.json"), "utf8"),
    ) as { exports: Record<string, Record<string, unknown>> };
    expect(manifest.exports["."]?.["browser"]).toEqual({
      types: "./dist/browser.d.ts",
      default: "./dist/browser.js",
    });
  });

  it("leaves out only the archive and the package reader", () => {
    const missing = Object.keys(nodeEntry)
      .filter((name) => !(name in browserEntry))
      .sort();
    expect(missing).toEqual([
      "MAX_ARCHIVE_ENTRIES",
      "MAX_DIRECTORY_RECORDS",
      "MAX_ENTRY_BYTES",
      "MAX_TOTAL_BYTES",
      "ThemeArchiveError",
      "lintThemeAgainst",
      "lintThemePackage",
      "readThemeArchive",
      "readThemePackage",
      "writeThemeArchive",
    ]);
  });
});
