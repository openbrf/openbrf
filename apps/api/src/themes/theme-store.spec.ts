import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { ThemeArchiveFiles } from "@openbrf/theme-tools";
import { ThemeStore } from "./theme-store";

/**
 * The data volume.
 *
 * A theme's files are written from a downloaded archive and later served back
 * to browsers, so one property under test is containment: nothing a package
 * names may be written or read outside the theme's own directory, whatever the
 * path looks like.
 *
 * The other is that the version already installed survives everything an
 * install can do to it short of succeeding. It is what every open page is
 * rendering, so a staged install that is discarded, and a swap that cannot be
 * completed, both have to leave it exactly where it was.
 */

/** Lets one test refuse the rename that moves a staged theme into place. */
const hooks = vi.hoisted(() => ({ failRenameInto: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      if (hooks.failRenameInto !== null && to.endsWith(hooks.failRenameInto)) {
        // Once only: what follows a refused swap is the restore, and the
        // restore is the thing under test.
        hooks.failRenameInto = null;
        throw new Error("The rename was refused.");
      }
      await actual.rename(from, to);
    },
  };
});

const encoder = new TextEncoder();

let dataDirectory: string;
let store: ThemeStore;

beforeEach(async () => {
  hooks.failRenameInto = null;
  dataDirectory = await mkdtemp(join(tmpdir(), "openbrf-theme-store-"));
  store = new ThemeStore({
    NODE_ENV: "test",
    OPENBRF_DATA_DIR: dataDirectory,
  } as Env);
});

afterEach(async () => {
  await rm(dataDirectory, { recursive: true, force: true });
});

function filesOf(entries: Record<string, string>): Map<string, Uint8Array> {
  return new Map(
    Object.entries(entries).map(([path, contents]) => [
      path,
      encoder.encode(contents),
    ]),
  );
}

/** Both halves of an install that succeeds, which most tests only need. */
async function install(
  themeId: string,
  files: ThemeArchiveFiles,
): Promise<void> {
  const staged = await store.stage(themeId, files);
  await staged.commit();
}

describe("ThemeStore", () => {
  it("writes a theme's files under its own directory", async () => {
    await install(
      "example-theme",
      filesOf({ "theme.json": "{}", "fonts/body.woff2": "font bytes" }),
    );

    const asset = await store.readAsset("example-theme", "fonts/body.woff2");
    expect(asset?.toString("utf8")).toBe("font bytes");
    expect(
      await readFile(
        join(dataDirectory, "themes", "example-theme", "theme.json"),
        "utf8",
      ),
    ).toBe("{}");
  });

  it("replaces an earlier version rather than merging into it", async () => {
    await install(
      "example-theme",
      filesOf({ "theme.json": "{}", "fonts/old.woff2": "old" }),
    );
    await install(
      "example-theme",
      filesOf({ "theme.json": "{}", "fonts/new.woff2": "new" }),
    );

    expect(
      await store.readAsset("example-theme", "fonts/new.woff2"),
    ).not.toBeNull();
    // A file the new version does not carry must not survive the replacement:
    // a stale font would still be served from the instance's own origin.
    expect(
      await store.readAsset("example-theme", "fonts/old.woff2"),
    ).toBeNull();
  });

  it("removes a theme", async () => {
    await install("example-theme", filesOf({ "theme.json": "{}" }));
    await store.remove("example-theme");
    expect(await store.readAsset("example-theme", "theme.json")).toBeNull();
  });

  it("refuses to write a path that escapes the theme directory", async () => {
    await expect(
      store.stage("example-theme", filesOf({ "../escaped.json": "{}" })),
    ).rejects.toThrow(/unusable path/);
  });

  it("does not read a path that escapes the theme directory", async () => {
    await writeFile(join(dataDirectory, "secret.txt"), "not yours", "utf8");
    await install("example-theme", filesOf({ "theme.json": "{}" }));

    for (const path of [
      "../secret.txt",
      "../../secret.txt",
      "/etc/passwd",
      "fonts/../../secret.txt",
    ]) {
      expect(await store.readAsset("example-theme", path)).toBeNull();
    }
  });

  it("leaves no staging directory behind after a failed write", async () => {
    await expect(
      store.stage("example-theme", filesOf({ "../escaped.json": "{}" })),
    ).rejects.toThrow();

    expect(await readdir(join(dataDirectory, "themes"))).toEqual([]);
  });
});

/**
 * What survives an install that does not finish.
 *
 * Staging is only worth the extra step if the version already installed is
 * untouched until the moment the new one replaces it, and comes back if that
 * moment fails. Otherwise a refused install would take the association's fonts
 * and logo down with it.
 */
describe("an install that does not complete", () => {
  it("leaves the installed version alone while a new one is staged", async () => {
    await install(
      "example-theme",
      filesOf({ "theme.json": "{}", "fonts/old.woff2": "old" }),
    );

    const staged = await store.stage(
      "example-theme",
      filesOf({ "theme.json": "{}", "fonts/new.woff2": "new" }),
    );

    expect(
      (await store.readAsset("example-theme", "fonts/old.woff2"))?.toString(
        "utf8",
      ),
    ).toBe("old");
    expect(
      await store.readAsset("example-theme", "fonts/new.woff2"),
    ).toBeNull();

    await staged.discard();

    expect(
      (await store.readAsset("example-theme", "fonts/old.woff2"))?.toString(
        "utf8",
      ),
    ).toBe("old");
    expect(await readdir(join(dataDirectory, "themes"))).toEqual([
      "example-theme",
    ]);
  });

  it("puts the previous version back when the swap into place fails", async () => {
    await install(
      "example-theme",
      filesOf({ "theme.json": "{}", "fonts/old.woff2": "old" }),
    );

    const staged = await store.stage(
      "example-theme",
      filesOf({ "theme.json": "{}", "fonts/new.woff2": "new" }),
    );

    hooks.failRenameInto = join("themes", "example-theme");
    await expect(staged.commit()).rejects.toThrow(/rename was refused/);

    // The version the interface is rendering is back where it was, none of the
    // refused install survives, and nothing is left on the volume to clean up.
    expect(
      (await store.readAsset("example-theme", "fonts/old.woff2"))?.toString(
        "utf8",
      ),
    ).toBe("old");
    expect(
      await store.readAsset("example-theme", "fonts/new.woff2"),
    ).toBeNull();
    expect(await readdir(join(dataDirectory, "themes"))).toEqual([
      "example-theme",
    ]);
  });
});
