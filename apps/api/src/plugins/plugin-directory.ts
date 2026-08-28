import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  isSupportedApiVersion,
  parsePluginPackage,
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

export type SkipReason =
  | "not-a-plugin"
  | "manifest-invalid"
  | "api-version-unsupported"
  | "entry-missing"
  | "unreadable";

export interface SkippedPlugin {
  directory: string;
  packageName: string | null;
  reason: SkipReason;
  detail: string;
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
      detail: parsed.issues.join("; "),
    };
  }

  const { openbrf: manifest, name, version } = parsed.value;

  if (!isSupportedApiVersion(manifest.apiVersion)) {
    return {
      directory,
      packageName: name,
      reason: "api-version-unsupported",
      detail:
        `The plugin declares apiVersion ${String(manifest.apiVersion)}, ` +
        `which this version of Open BRF does not implement.`,
    };
  }

  const serverEntry = await resolveEntry(directory, manifest.entry.server);
  if (serverEntry !== null && "missing" in serverEntry) {
    return {
      directory,
      packageName: name,
      reason: "entry-missing",
      detail: `The declared server entry ${serverEntry.missing} is not in the package.`,
    };
  }

  const clientEntry = await resolveEntry(directory, manifest.entry.client);
  if (clientEntry !== null && "missing" in clientEntry) {
    return {
      directory,
      packageName: name,
      reason: "entry-missing",
      detail: `The declared client entry ${clientEntry.missing} is not in the package.`,
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
 */
async function resolveEntry(
  directory: string,
  declared: string | undefined,
): Promise<{ path: string } | { missing: string } | null> {
  if (declared === undefined) {
    return null;
  }

  const candidate = resolve(directory, declared);
  const inside = relative(resolve(directory), candidate);
  if (inside.startsWith("..") || inside.startsWith(sep) || inside === "") {
    return { missing: declared };
  }

  try {
    const info = await stat(candidate);
    return info.isFile() ? { path: candidate } : { missing: declared };
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
