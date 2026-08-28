import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse, relative, sep } from "node:path";

import { writeThemeArchive } from "@openbrf/theme-tools";

/**
 * Builds a theme catalog out of the fixtures in `fixtures/themes`.
 *
 * The catalog and the example theme belong in repositories of their own, which
 * do not exist yet. This stands in for them, and it is what the plan calls for
 * in CI regardless: the same install path, the same checksum verification and
 * the same lint, run against packages built in the repository with no network
 * involved.
 *
 * A fixture directory holds the theme's own files plus an optional
 * `fixture.json` naming files to copy in from elsewhere in the repository. That
 * exists for exactly one thing: the example theme bundles a real font, and
 * committing a second copy of a font the core already ships would be dead
 * weight. `fixture.json` is not part of the theme package format and never
 * reaches the archive.
 */

export interface FixtureCatalogEntry {
  id: string;
  type: "theme";
  name: string;
  description?: string;
  version: string;
  /** Relative to the catalog file, which is how the source resolves it. */
  url: string;
  sha512: string;
  contract: string;
}

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

async function collectFiles(
  directory: string,
  base: string = directory,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [path, contents] of await collectFiles(full, base)) {
        files.set(path, contents);
      }
      continue;
    }
    const path = relative(base, full).split(sep).join("/");
    files.set(path, new Uint8Array(await readFile(full)));
  }

  return files;
}

/**
 * Packs every fixture theme and writes a catalog naming them.
 *
 * Returns the catalog path, which is what OPENBRF_CATALOG_URL is pointed at.
 */
export async function buildThemeFixtureCatalog(
  target: string,
): Promise<FixtureCatalog> {
  const root = repositoryRoot();
  const source = join(root, "fixtures", "themes");
  await mkdir(target, { recursive: true });

  const entries: FixtureCatalogEntry[] = [];

  for (const directory of await readdir(source, { withFileTypes: true })) {
    if (!directory.isDirectory()) {
      continue;
    }

    const themeDirectory = join(source, directory.name);
    const files = await collectFiles(themeDirectory);

    const sidecar = files.get("fixture.json");
    files.delete("fixture.json");
    if (sidecar !== undefined) {
      const included = JSON.parse(new TextDecoder("utf8").decode(sidecar)) as {
        include?: Record<string, string>;
      };
      for (const [path, from] of Object.entries(included.include ?? {})) {
        files.set(path, new Uint8Array(await readFile(join(root, from))));
      }
    }

    const manifestFile = files.get("theme.json");
    if (manifestFile === undefined) {
      throw new Error(`Fixture ${directory.name} has no theme.json.`);
    }
    const manifest = JSON.parse(
      new TextDecoder("utf8").decode(manifestFile),
    ) as {
      name: string;
      displayName: string;
      version: string;
      description?: string;
      contract: string;
    };

    const archive = writeThemeArchive(files);
    const fileName = `${manifest.name}-${manifest.version}.tgz`;
    await writeFile(join(target, fileName), archive);

    entries.push({
      id: manifest.name,
      type: "theme",
      name: manifest.displayName,
      ...(manifest.description === undefined
        ? {}
        : { description: manifest.description }),
      version: manifest.version,
      url: fileName,
      sha512: createHash("sha512").update(archive).digest("hex"),
      contract: manifest.contract,
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));

  const catalogPath = join(target, "catalog.json");
  await writeFile(
    catalogPath,
    `${JSON.stringify({ entries }, null, 2)}\n`,
    "utf8",
  );

  return { directory: target, catalogPath, entries };
}
