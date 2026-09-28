import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { promisify } from "node:util";

import {
  type CatalogThemeEntry,
  parseCatalog,
} from "../packaging/catalog-entry";

/**
 * Builds a theme catalog out of the fixtures in `fixtures/themes`.
 *
 * The same script that builds the fixture index for the plugin suites and the
 * end-to-end stack, asked for the themes only: one builder, so the index the
 * theme suites read is in the format every other reader of it expects. It
 * packs the themes with no network and no toolchain beyond theme-tools, which
 * is what lets a unit test call it.
 */

const run = promisify(execFile);

export type FixtureCatalogEntry = CatalogThemeEntry;

export interface FixtureCatalog {
  /** The directory holding catalog.json and the packages. */
  directory: string;
  catalogPath: string;
  entries: FixtureCatalogEntry[];
}

/** Walks upward for the workspace root, which is where fixtures/ lives. */
export function repositoryRoot(from: string = process.cwd()): string {
  const { root } = parse(from);
  let directory = from;

  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      return directory;
    }
    if (directory === root) {
      throw new Error("Could not find the workspace root from " + from + ".");
    }
    directory = dirname(directory);
  }
}

/**
 * Packs every fixture theme into `target` and writes a catalog naming them.
 *
 * Returns the catalog path; its file URL is what OPENBRF_CATALOG_URL is
 * pointed at.
 */
export async function buildThemeFixtureCatalog(
  target: string,
): Promise<FixtureCatalog> {
  const root = repositoryRoot();
  await mkdir(target, { recursive: true });

  await run(
    "node",
    [
      join(root, "scripts", "build-fixture-catalog.mjs"),
      "--kind",
      "theme",
      "--out",
      target,
    ],
    { cwd: root, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
  );

  const catalogPath = join(target, "catalog.json");
  const catalog = parseCatalog(JSON.parse(await readFile(catalogPath, "utf8")));

  return {
    directory: target,
    catalogPath,
    entries: catalog.entries.filter(
      (entry): entry is CatalogThemeEntry => entry.type === "theme",
    ),
  };
}
