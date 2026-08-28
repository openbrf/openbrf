import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bridgeHostResolution,
  findResolutionConflicts,
  HOST_SHARED_PACKAGES,
  hostModulesDirectory,
} from "./plugin-resolution";

/**
 * The resolution bridge from ADR 0003.
 *
 * Plugins live on a data volume with no relationship to the application's own
 * node_modules, so Node's CJS lookup walks up from the plugin's directory and
 * never reaches the host's packages. NODE_PATH fixes that, but only as a
 * fallback - a copy of a shared package sitting beside the plugin still wins.
 *
 * That is why the conflict check asserts identity of the resolved file rather
 * than the absence of an error, and it is why `npm install --omit=peer` alone
 * is not sufficient: a duplicate @nestjs/common loads happily, decorates
 * happily, and then fails at a ModuleRef lookup or an instanceof long after the
 * install looked successful. These tests run against real directories, because
 * the subject is Node's own resolver and there is nothing else to measure.
 */

const SAVED_NODE_PATH = process.env.NODE_PATH;

let workspace: string;
/** A plugin directory with no copy of a shared package anywhere above it. */
let cleanPlugin: string;
/** A plugin directory with a duplicate @nestjs/common in a sibling tree. */
let shadowedPlugin: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "openbrf-resolution-"));

  cleanPlugin = join(workspace, "clean", "plugin");
  await mkdir(cleanPlugin, { recursive: true });

  const shadowed = join(workspace, "shadowed");
  shadowedPlugin = join(shadowed, "plugin");
  await mkdir(shadowedPlugin, { recursive: true });

  const duplicate = join(shadowed, "node_modules", "@nestjs", "common");
  await mkdir(duplicate, { recursive: true });
  await writeFile(
    join(duplicate, "package.json"),
    JSON.stringify({
      name: "@nestjs/common",
      version: "0.0.0",
      main: "index.js",
    }),
  );
  await writeFile(join(duplicate, "index.js"), "module.exports = {};");

  // The conflict check reproduces what a plugin's own require would find,
  // NODE_PATH fallback included, so the bridge has to be in place before it is
  // asked anything.
  bridgeHostResolution();
});

afterAll(async () => {
  if (SAVED_NODE_PATH === undefined) {
    delete process.env.NODE_PATH;
  } else {
    process.env.NODE_PATH = SAVED_NODE_PATH;
  }
  await rm(workspace, { recursive: true, force: true });
});

function nodePathEntries(): string[] {
  const separator = process.platform === "win32" ? ";" : ":";
  return (process.env.NODE_PATH ?? "")
    .split(separator)
    .filter((entry) => entry !== "");
}

describe("hostModulesDirectory", () => {
  it("finds the node_modules the host's own packages resolved from", () => {
    // Derived from where a host package actually resolved rather than assembled
    // from a guess about the layout, so it stays right whether the application
    // runs from src, from dist, or from a flattened image.
    const directory = hostModulesDirectory();

    expect(directory).not.toBeNull();
    expect(basename(directory ?? "")).toBe("node_modules");
  });

  it("names a directory that exists", async () => {
    const directory = hostModulesDirectory();
    if (directory === null) {
      throw new Error("The host's node_modules could not be located.");
    }

    expect((await stat(directory)).isDirectory()).toBe(true);
  });
});

describe("bridgeHostResolution", () => {
  it("returns the host's node_modules and leaves it on NODE_PATH", () => {
    // Setting the variable is not enough on its own - Node reads it once at
    // process start - so this also stands in for _initPaths having been run.
    const bridged = bridgeHostResolution();

    expect(bridged).toBe(hostModulesDirectory());
    expect(nodePathEntries()).toContain(bridged);
  });

  it("adds the entry once however often it is called", () => {
    // Called before every load, and a NODE_PATH that grows a duplicate on each
    // call is a slow leak into every child process the instance spawns.
    bridgeHostResolution();
    bridgeHostResolution();

    const bridged = hostModulesDirectory();
    const occurrences = nodePathEntries().filter(
      (entry) => entry === bridged,
    ).length;

    expect(occurrences).toBe(1);
  });

  it("puts the bridged directory ahead of whatever was already on NODE_PATH", () => {
    // Only a fallback either way - a copy beside the plugin still wins - but
    // ahead of any unrelated entry the operator's environment happened to
    // carry, so a stray directory cannot shadow the host's own packages.
    //
    // The stray entry has to be planted first. With an empty NODE_PATH the
    // variable ends up holding one entry, where "first" and "last" are the
    // same position and the assertion would go on passing if the bridge
    // started appending.
    const stray = join(workspace, "stray_modules");
    process.env.NODE_PATH = stray;

    bridgeHostResolution();

    expect(nodePathEntries()[0]).toBe(hostModulesDirectory());
    expect(nodePathEntries()).toContain(stray);
  });
});

describe("findResolutionConflicts", () => {
  it("reports nothing for a plugin with no copy of its own", () => {
    // The bridge resolves the shared packages to the host's copies, which is
    // the state every correctly installed plugin is in.
    expect(findResolutionConflicts(cleanPlugin)).toEqual([]);
  });

  it("reports a duplicate installed beside the plugin", () => {
    // The ADR 0003 identity assertion, and the reason --omit=peer alone is not
    // enough: NODE_PATH is only a fallback, so a copy npm placed beside the
    // plugin wins over the host's. Everything in HOST_SHARED_PACKAGES holds
    // process-wide state, so a second copy is not a duplicate - it is a second
    // and disconnected system, and it fails long after the install looked fine.
    const conflicts = findResolutionConflicts(shadowedPlugin);

    expect(conflicts.map((conflict) => conflict.package)).toEqual([
      "@nestjs/common",
    ]);
    const [conflict] = conflicts;
    expect(conflict?.pluginPath).not.toBe(conflict?.hostPath);
    expect(conflict?.pluginPath).toContain(join("shadowed", "node_modules"));
  });

  it("checks the packages that hold process-wide state by default", () => {
    // A second copy of either is a second DI container and metadata registry,
    // which is why they are the ones a plugin may not carry its own copy of.
    expect(HOST_SHARED_PACKAGES).toContain("@nestjs/common");
    expect(HOST_SHARED_PACKAGES).toContain("@nestjs/core");
  });

  it("turns a resolution failure into no finding rather than an error", () => {
    // A plugin that never touches NestJS is the common case, and a package
    // neither side can resolve must produce an empty result: demanding that a
    // plugin resolve a package it does not use would refuse exactly the plugins
    // that follow the bundling contract most closely.
    expect(
      findResolutionConflicts(cleanPlugin, [
        "@openbrf/definitely-not-installed",
      ]),
    ).toEqual([]);
  });
});
