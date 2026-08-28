import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../config/env";
import { ThemeStore } from "./theme-store";

/**
 * The data volume.
 *
 * A theme's files are written from a downloaded archive and later served back
 * to browsers, so the property under test is containment: nothing a package
 * names may be written or read outside the theme's own directory, whatever the
 * path looks like.
 */

const encoder = new TextEncoder();

let dataDirectory: string;
let store: ThemeStore;

beforeEach(async () => {
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

describe("ThemeStore", () => {
  it("writes a theme's files under its own directory", async () => {
    await store.write(
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
    await store.write(
      "example-theme",
      filesOf({ "theme.json": "{}", "fonts/old.woff2": "old" }),
    );
    await store.write(
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
    await store.write("example-theme", filesOf({ "theme.json": "{}" }));
    await store.remove("example-theme");
    expect(await store.readAsset("example-theme", "theme.json")).toBeNull();
  });

  it("refuses to write a path that escapes the theme directory", async () => {
    await expect(
      store.write("example-theme", filesOf({ "../escaped.json": "{}" })),
    ).rejects.toThrow(/unusable path/);
  });

  it("does not read a path that escapes the theme directory", async () => {
    await writeFile(join(dataDirectory, "secret.txt"), "not yours", "utf8");
    await store.write("example-theme", filesOf({ "theme.json": "{}" }));

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
      store.write("example-theme", filesOf({ "../escaped.json": "{}" })),
    ).rejects.toThrow();

    const { readdir } = await import("node:fs/promises");
    const contents = await readdir(join(dataDirectory, "themes"));
    expect(contents).toEqual([]);
  });
});
