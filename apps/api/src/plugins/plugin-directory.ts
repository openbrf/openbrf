import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  isSupportedApiVersion,
  parsePluginPackage,
  type PluginFindingDetail,
  type PluginFindingReason,
  type PluginManifest,
} from "@openbrf/plugin-sdk";

/**
 * Reading what is actually installed on the data volume.
 *
 * The rule that shapes every branch here: a malformed plugin directory is
 * skipped and reported, never fatal (ADR 0003). A broken plugin must not be
 * able to take the association's register offline, so nothing in this file
 * throws for a plugin's own defect - it returns the defect as a finding the
 * caller logs and shows on the admin screen.
 */

export interface DiscoveredPlugin {
  id: string;
  packageName: string;
  version: string;
  /** Absolute path to the installed package. */
  directory: string;
  manifest: PluginManifest;
  /** Absolute path to the server bundle, when the plugin has one. */
  serverEntry: string | null;
  /** Absolute path to the client remote entry, when the plugin has one. */
  clientEntry: string | null;
}

/**
 * Why a candidate directory was skipped.
 *
 * Narrowed from the contract's own set rather than declared here, so a skip
 * cannot name a code the admin screen has no sentence for. A directory that is
 * not a plugin at all is not in it: that is not a skip and not a finding, it is
 * one of the transitive dependencies npm puts in the same tree.
 */
export type SkipReason = Extract<
  PluginFindingReason,
  "manifest-invalid" | "api-version-unsupported" | "entry-missing"
>;

export interface SkippedPlugin {
  directory: string;
  packageName: string | null;
  reason: SkipReason;
  /** Values for the sentence the admin screen reads the reason as. */
  detail: PluginFindingDetail;
}

export interface DirectoryScan {
  plugins: DiscoveredPlugin[];
  skipped: SkippedPlugin[];
}

/** npm installs into node_modules under the directory it is given. */
export function pluginModulesDirectory(pluginsRoot: string): string {
  return join(pluginsRoot, "node_modules");
}

/**
 * Scans the installation directory.
 *
 * Package directories are enumerated the way npm lays them out, one level for
 * an unscoped package and two for a scoped one. Anything that is not a
 * readable package with an `openbrf` manifest is simply not a plugin -
 * npm puts transitive dependencies in the same tree, and reporting each of
 * them as a broken plugin would bury the one finding that matters.
 */
export async function scanPluginDirectory(
  pluginsRoot: string,
): Promise<DirectoryScan> {
  const modules = pluginModulesDirectory(pluginsRoot);
  const scan: DirectoryScan = { plugins: [], skipped: [] };

  for (const directory of await packageDirectories(modules)) {
    const outcome = await readPluginDirectory(directory);
    if (outcome === null) {
      continue;
    }
    if ("reason" in outcome) {
      scan.skipped.push(outcome);
    } else {
      scan.plugins.push(outcome);
    }
  }

  scan.plugins.sort((left, right) => left.id.localeCompare(right.id));
  return scan;
}

/**
 * Reads one candidate directory.
 *
 * Returns null for a directory that is not a plugin at all, a SkippedPlugin
 * for one that claims to be a plugin and is not usable, and a DiscoveredPlugin
 * otherwise. The three-way answer exists because "not a plugin" and "a broken
 * plugin" must not look the same on the admin screen.
 */
export async function readPluginDirectory(
  directory: string,
): Promise<DiscoveredPlugin | SkippedPlugin | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  } catch {
    return null;
  }

  if (
    typeof raw !== "object" ||
    raw === null ||
    !("openbrf" in raw) ||
    (raw as { openbrf: unknown }).openbrf === undefined
  ) {
    return null;
  }

  const declaredName = (raw as Record<string, unknown>).name;
  const packageName = typeof declaredName === "string" ? declaredName : null;

  const parsed = parsePluginPackage(raw);
  if (!parsed.ok) {
    return {
      directory,
      packageName,
      reason: "manifest-invalid",
      detail: { issues: parsed.issues.join("; ") },
    };
  }

  const { openbrf: manifest, name, version } = parsed.value;

  if (!isSupportedApiVersion(manifest.apiVersion)) {
    return {
      directory,
      packageName: name,
      reason: "api-version-unsupported",
      detail: { apiVersion: manifest.apiVersion },
    };
  }

  const serverEntry = await resolveEntry(directory, manifest.entry.server);
  if (serverEntry !== null && "missing" in serverEntry) {
    return {
      directory,
      packageName: name,
      reason: "entry-missing",
      detail: { entry: serverEntry.missing },
    };
  }

  const clientEntry = await resolveEntry(directory, manifest.entry.client);
  if (clientEntry !== null && "missing" in clientEntry) {
    return {
      directory,
      packageName: name,
      reason: "entry-missing",
      detail: { entry: clientEntry.missing },
    };
  }

  return {
    id: manifest.id,
    packageName: name,
    version,
    directory,
    manifest,
    serverEntry: serverEntry?.path ?? null,
    clientEntry: clientEntry?.path ?? null,
  };
}

/**
 * Resolves a declared entry path inside the package.
 *
 * The manifest schema already rejects an absolute path and a parent segment;
 * this checks the resolved result against the package directory as well. The
 * schema guards the shape of the string, this guards the outcome - a symlink
 * inside the tarball could satisfy the first and defeat it.
 *
 * The comparison is between real paths, not lexical ones. `resolve` does no
 * filesystem work, so a link at `dist/server.cjs` pointing anywhere at all
 * still produces a candidate that reads as being inside the package, and
 * `stat` follows the link and reports a file. What the loader then requires
 * and runs at full process privilege is whatever the link named.
 */
async function resolveEntry(
  directory: string,
  declared: string | undefined,
): Promise<{ path: string } | { missing: string } | null> {
  if (declared === undefined) {
    return null;
  }

  const candidate = resolve(directory, declared);

  try {
    // The package directory is resolved too: npm and pnpm both lay out trees
    // where a package directory is itself a link, and comparing a real path
    // against a lexical base would reject every entry in one.
    const [base, target] = await Promise.all([
      realpath(directory),
      realpath(candidate),
    ]);
    const inside = relative(base, target);
    if (inside.startsWith("..") || inside.startsWith(sep) || inside === "") {
      return { missing: declared };
    }
    const info = await stat(target);
    return info.isFile() ? { path: target } : { missing: declared };
  } catch {
    return { missing: declared };
  }
}

/**
 * Every installed package directory, scoped packages included.
 *
 * Returns an empty list when the tree does not exist: a fresh instance has
 * never installed anything, and that is not an error to report.
 */
async function packageDirectories(modules: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await readdir(modules, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }

  const directories: string[] = [];
  for (const name of entries) {
    if (!name.startsWith("@")) {
      directories.push(join(modules, name));
      continue;
    }
    try {
      const scoped = await readdir(join(modules, name), {
        withFileTypes: true,
      });
      for (const entry of scoped) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          directories.push(join(modules, name, entry.name));
        }
      }
    } catch {
      // An unreadable scope directory contributes no plugins and is not worth
      // a finding: npm owns this tree and a partial one converges on the next
      // reconcile.
    }
  }

  return directories;
}
