import { isAbsolute, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { dataPaths } from "./data-paths";

/**
 * One place decides these names because the loader, the installer, the CLI and
 * the theme engine all have to agree on them. The invariants worth holding are
 * the containment ones: everything stays under the configured data root, and
 * the archives a reinstall needs stay inside the plugins directory so a single
 * volume mount carries both. A path that escaped either would produce an
 * instance that installs into a directory it never scans, or one whose backup
 * covers the install but not the tarballs it was built from.
 */

const ROOT = "/srv/openbrf/data";

function isUnder(parent: string, child: string): boolean {
  return child.startsWith(`${parent}${sep}`);
}

describe("dataPaths", () => {
  it("puts every path under the resolved root", () => {
    const paths = dataPaths(ROOT);

    expect(paths.root).toBe(resolve(ROOT));
    for (const path of [
      paths.plugins,
      paths.pluginArchives,
      paths.pluginStaging,
      paths.themes,
    ]) {
      expect(isUnder(paths.root, path)).toBe(true);
    }
  });

  it("keeps the archives and the staging area inside the plugins directory", () => {
    const paths = dataPaths(ROOT);

    expect(isUnder(paths.plugins, paths.pluginArchives)).toBe(true);
    expect(isUnder(paths.plugins, paths.pluginStaging)).toBe(true);
  });

  it("keeps themes out of the plugins directory", () => {
    // npm owns the plugins tree and prunes what it does not know about; a theme
    // stored inside it would be removed by the next plugin install.
    const paths = dataPaths(ROOT);

    expect(isUnder(paths.plugins, paths.themes)).toBe(false);
  });

  it("gives each path its own name", () => {
    const paths = dataPaths(ROOT);
    const all = [
      paths.root,
      paths.plugins,
      paths.pluginArchives,
      paths.pluginStaging,
      paths.themes,
    ];

    expect(new Set(all).size).toBe(all.length);
  });

  it("resolves a relative data directory to an absolute one", () => {
    // The process working directory is not stable across the API, the CLI and a
    // job worker, so a relative configuration value is anchored once, here.
    const paths = dataPaths("./var/openbrf");

    expect(isAbsolute(paths.root)).toBe(true);
    expect(paths.root).toBe(resolve("./var/openbrf"));
    for (const path of [
      paths.plugins,
      paths.pluginArchives,
      paths.pluginStaging,
      paths.themes,
    ]) {
      expect(isAbsolute(path)).toBe(true);
      expect(isUnder(paths.root, path)).toBe(true);
    }
  });

  it("normalizes a root containing a parent segment", () => {
    expect(dataPaths("/srv/openbrf/../openbrf/data").root).toBe(resolve(ROOT));
  });
});
