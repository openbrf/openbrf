import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PLUGIN_API_VERSION } from "@openbrf/plugin-sdk";

import {
  pluginModulesDirectory,
  scanPluginDirectory,
  type SkipReason,
} from "./plugin-directory";

/**
 * The scan is run against real directories laid out the way npm lays them out.
 * This code exists to read a filesystem it did not write, and a mocked one
 * would test the mock rather than the layout npm actually produces.
 *
 * Every assertion here serves one rule from ADR 0003: a malformed plugin is
 * skipped and reported, never fatal. A broken plugin must not be able to take
 * the association's register offline, and it must not be able to hide a working
 * plugin installed beside it either.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbrf-plugins-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface InstalledPackage {
  /** The npm package name, which is also its directory under node_modules. */
  packageName: string;
  /** Omitted entirely for a package that is not a plugin. */
  manifest?: Record<string, unknown>;
  version?: string;
  /** Files to create inside the package, relative to it. */
  files?: string[];
}

/** Lays a package out under node_modules the way npm would. */
async function install({
  packageName,
  manifest,
  version = "1.0.0",
  files = [],
}: InstalledPackage): Promise<string> {
  const directory = join(pluginModulesDirectory(root), packageName);
  await mkdir(directory, { recursive: true });

  const packageJson: Record<string, unknown> = { name: packageName, version };
  if (manifest !== undefined) {
    packageJson.openbrf = manifest;
  }
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(packageJson, null, 2),
  );

  for (const file of files) {
    const path = join(directory, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "module.exports = {};");
  }

  return directory;
}

function validManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiVersion: PLUGIN_API_VERSION,
    id: "occupancy",
    entry: { server: "dist/server.cjs" },
    ...overrides,
  };
}

function reasonFor(
  skipped: readonly { directory: string; reason: SkipReason }[],
  directory: string,
): SkipReason | undefined {
  return skipped.find((entry) => entry.directory === directory)?.reason;
}

describe("scanPluginDirectory", () => {
  it("returns empty lists for a directory that does not exist", async () => {
    // A fresh instance has never installed anything, and that is not a finding
    // to report, let alone an error to boot on.
    const scan = await scanPluginDirectory(join(root, "never-created"));

    expect(scan.plugins).toEqual([]);
    expect(scan.skipped).toEqual([]);
  });

  it("returns empty lists for an installation root with no node_modules", async () => {
    const scan = await scanPluginDirectory(root);

    expect(scan.plugins).toEqual([]);
    expect(scan.skipped).toEqual([]);
  });

  it("does not report a package without an openbrf field at all", async () => {
    // npm puts transitive dependencies in the same tree. Reporting each of them
    // as a broken plugin would bury the one finding that matters, so a package
    // that never claimed to be a plugin appears in neither list.
    const directory = await install({ packageName: "lodash" });

    const scan = await scanPluginDirectory(root);

    expect(scan.plugins).toEqual([]);
    expect(scan.skipped).toEqual([]);
    expect(
      [...scan.plugins, ...scan.skipped].map((entry) => entry.directory),
    ).not.toContain(directory);
  });

  it("discovers a valid plugin with absolute entry paths", async () => {
    const directory = await install({
      packageName: "openbrf-plugin-occupancy",
      manifest: validManifest({
        entry: { server: "dist/server.cjs", client: "dist/remote.js" },
        permissions: ["addressBook:read"],
      }),
      version: "1.4.0",
      files: ["dist/server.cjs", "dist/remote.js"],
    });

    const scan = await scanPluginDirectory(root);

    expect(scan.skipped).toEqual([]);
    expect(scan.plugins).toHaveLength(1);
    const [plugin] = scan.plugins;
    expect(plugin?.id).toBe("occupancy");
    expect(plugin?.packageName).toBe("openbrf-plugin-occupancy");
    expect(plugin?.version).toBe("1.4.0");
    expect(plugin?.directory).toBe(directory);
    expect(plugin?.manifest.permissions).toEqual(["addressBook:read"]);
    /*
     * The loader requires the bundle by path, from a working directory that is
     * not the plugin's, so a relative entry would resolve somewhere else.
     *
     * Compared against the real path, because that is what the scan returns:
     * containment is decided after links are resolved, and the value that was
     * checked has to be the value that gets required. The temporary directory
     * itself is reached through a link on macOS, which is why the two spellings
     * differ here at all.
     */
    const real = await realpath(directory);
    expect(plugin?.serverEntry).toBe(join(real, "dist", "server.cjs"));
    expect(plugin?.clientEntry).toBe(join(real, "dist", "remote.js"));
    expect(isAbsolute(plugin?.serverEntry ?? "")).toBe(true);
    expect(isAbsolute(plugin?.clientEntry ?? "")).toBe(true);
  });

  it("leaves the entry it was not given as null", async () => {
    // A plugin may contribute a view and no backend behaviour, or the reverse.
    await install({
      packageName: "openbrf-plugin-view-only",
      manifest: validManifest({
        id: "view-only",
        entry: { client: "dist/remote.js" },
      }),
      files: ["dist/remote.js"],
    });

    const scan = await scanPluginDirectory(root);

    expect(scan.plugins[0]?.serverEntry).toBeNull();
    expect(scan.plugins[0]?.clientEntry).not.toBeNull();
  });

  it("skips a package whose openbrf field does not validate", async () => {
    const directory = await install({
      packageName: "openbrf-plugin-broken",
      manifest: { apiVersion: PLUGIN_API_VERSION, id: "NOT VALID", entry: {} },
    });

    const scan = await scanPluginDirectory(root);

    expect(reasonFor(scan.skipped, directory)).toBe("manifest-invalid");
    expect(scan.plugins).toEqual([]);
  });

  it("names the package on a skipped entry so the finding is actionable", async () => {
    const directory = await install({
      packageName: "openbrf-plugin-broken",
      manifest: { id: "broken" },
    });

    const scan = await scanPluginDirectory(root);

    const skipped = scan.skipped.find((entry) => entry.directory === directory);
    expect(skipped?.packageName).toBe("openbrf-plugin-broken");
    expect(skipped?.detail).not.toBe("");
  });

  it("skips a plugin declaring an apiVersion this host does not implement", async () => {
    // The apiVersion gate. The contract is binary on purpose: a plugin either
    // speaks the version this host implements or it is not loaded, rather than
    // being loaded and failing at the first call the newer contract removed.
    const directory = await install({
      packageName: "openbrf-plugin-future",
      manifest: validManifest({ id: "future", apiVersion: 99 }),
      files: ["dist/server.cjs"],
    });

    const scan = await scanPluginDirectory(root);

    expect(reasonFor(scan.skipped, directory)).toBe("api-version-unsupported");
    expect(scan.plugins).toEqual([]);
  });

  it("skips a plugin whose declared server entry is not in the package", async () => {
    const directory = await install({
      packageName: "openbrf-plugin-empty",
      manifest: validManifest({ id: "empty" }),
    });

    const scan = await scanPluginDirectory(root);

    expect(reasonFor(scan.skipped, directory)).toBe("entry-missing");
  });

  it("skips a plugin whose declared client entry is not in the package", async () => {
    const directory = await install({
      packageName: "openbrf-plugin-half",
      manifest: validManifest({
        id: "half",
        entry: { server: "dist/server.cjs", client: "dist/remote.js" },
      }),
      files: ["dist/server.cjs"],
    });

    const scan = await scanPluginDirectory(root);

    expect(reasonFor(scan.skipped, directory)).toBe("entry-missing");
  });

  it("skips a plugin whose entry names a directory rather than a file", async () => {
    const directory = await install({
      packageName: "openbrf-plugin-directory-entry",
      manifest: validManifest({ id: "dir-entry", entry: { server: "dist" } }),
      files: ["dist/server.cjs"],
    });

    const scan = await scanPluginDirectory(root);

    expect(reasonFor(scan.skipped, directory)).toBe("entry-missing");
  });

  /**
   * The containment check is what stops a package pointing the loader at a
   * file outside itself. A lexical check cannot do it: `resolve` does no
   * filesystem work, so a link at the declared path yields a candidate that
   * reads as being inside the package, and `stat` follows the link and reports
   * a file. What the loader would then require and run at full process
   * privilege is whatever the link named.
   */
  it("skips a plugin whose entry is a symlink out of the package", async () => {
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const escape = join(outside, "elsewhere.cjs");
    await writeFile(escape, "module.exports = {};");

    const directory = await install({
      packageName: "openbrf-plugin-linked-entry",
      manifest: validManifest({
        id: "linked-entry",
        entry: { server: "dist/server.cjs" },
      }),
    });
    await mkdir(join(directory, "dist"), { recursive: true });
    await symlink(escape, join(directory, "dist", "server.cjs"));

    const scan = await scanPluginDirectory(root);

    expect(reasonFor(scan.skipped, directory)).toBe("entry-missing");
    expect(scan.plugins.map((plugin) => plugin.id)).not.toContain(
      "linked-entry",
    );
  });

  it("accepts an entry reached through a symlink that stays inside", async () => {
    // Containment, not "no links at all": a package is free to lay itself out
    // with one, and both npm and pnpm produce trees where a path is reached
    // through one.
    const directory = await install({
      packageName: "openbrf-plugin-inner-link",
      manifest: validManifest({
        id: "inner-link",
        entry: { server: "dist/server.cjs" },
      }),
      files: ["build/server.cjs"],
    });
    await mkdir(join(directory, "dist"), { recursive: true });
    await symlink(
      join(directory, "build", "server.cjs"),
      join(directory, "dist", "server.cjs"),
    );

    const scan = await scanPluginDirectory(root);

    expect(scan.plugins.map((plugin) => plugin.id)).toContain("inner-link");
  });

  it("finds a scoped package", async () => {
    // npm nests a scoped package one level deeper, so the scan has to walk
    // both layouts or every plugin published under a scope goes unseen.
    const directory = await install({
      packageName: "@openbrf/plugin-occupancy",
      manifest: validManifest(),
      files: ["dist/server.cjs"],
    });

    const scan = await scanPluginDirectory(root);

    expect(scan.plugins).toHaveLength(1);
    expect(scan.plugins[0]?.directory).toBe(directory);
  });

  it("sorts the discovered plugins by id", async () => {
    // The directory order npm produces is not the order an operator reads. The
    // package directories here sort the other way round on purpose.
    await install({
      packageName: "a-package",
      manifest: validManifest({ id: "zulu" }),
      files: ["dist/server.cjs"],
    });
    await install({
      packageName: "m-package",
      manifest: validManifest({ id: "mike" }),
      files: ["dist/server.cjs"],
    });
    await install({
      packageName: "z-package",
      manifest: validManifest({ id: "alpha" }),
      files: ["dist/server.cjs"],
    });

    const scan = await scanPluginDirectory(root);

    expect(scan.plugins.map((plugin) => plugin.id)).toEqual([
      "alpha",
      "mike",
      "zulu",
    ]);
  });

  it("discovers a working plugin installed beside broken ones", async () => {
    // The single most important assertion in this file, and the whole of the
    // "skip and report, never fatal" rule from ADR 0003. Every kind of defect
    // is present in the same tree as one good plugin, and the good one is still
    // registered: a broken plugin cannot take the register offline, and it
    // cannot take a working plugin down with it either.
    await install({
      packageName: "openbrf-plugin-invalid",
      manifest: { apiVersion: PLUGIN_API_VERSION, id: "NOT VALID", entry: {} },
    });
    await install({
      packageName: "openbrf-plugin-future",
      manifest: validManifest({ id: "future", apiVersion: 99 }),
      files: ["dist/server.cjs"],
    });
    await install({
      packageName: "openbrf-plugin-empty",
      manifest: validManifest({ id: "empty" }),
    });
    await install({ packageName: "some-transitive-dependency" });
    const good = await install({
      packageName: "openbrf-plugin-occupancy",
      manifest: validManifest(),
      files: ["dist/server.cjs"],
    });

    const scan = await scanPluginDirectory(root);

    expect(scan.plugins.map((plugin) => plugin.id)).toEqual(["occupancy"]);
    expect(scan.plugins[0]?.directory).toBe(good);
    expect(scan.skipped).toHaveLength(3);
    expect(scan.skipped.map((entry) => entry.reason).sort()).toEqual([
      "api-version-unsupported",
      "entry-missing",
      "manifest-invalid",
    ]);
  });

  it("ignores a package whose package.json is not readable JSON", async () => {
    // npm owns this tree and a half-written package.json converges on the next
    // reconcile. It is not a plugin defect, so it is not reported as one.
    const directory = join(pluginModulesDirectory(root), "half-written");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), "{ not json");

    const scan = await scanPluginDirectory(root);

    expect(scan.plugins).toEqual([]);
    expect(scan.skipped).toEqual([]);
  });

  it("ignores npm's own bookkeeping directories", async () => {
    await mkdir(join(pluginModulesDirectory(root), ".bin"), {
      recursive: true,
    });
    await install({
      packageName: "openbrf-plugin-occupancy",
      manifest: validManifest(),
      files: ["dist/server.cjs"],
    });

    const scan = await scanPluginDirectory(root);

    expect(scan.plugins).toHaveLength(1);
    expect(scan.skipped).toEqual([]);
  });
});

describe("pluginModulesDirectory", () => {
  it("points at the node_modules npm installs into", () => {
    expect(pluginModulesDirectory("/data/plugins")).toBe(
      join("/data/plugins", "node_modules"),
    );
  });
});
