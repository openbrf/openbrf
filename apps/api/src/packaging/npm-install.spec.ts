import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { npmInstall } from "./npm-install";

/**
 * What npm is started with, read back from a stand-in that records it.
 *
 * The stand-in writes its arguments and its whole environment into the
 * directory it was run in, so the assertions are about the process npm would
 * have been, not about the options object that described it.
 */

const HOST_SECRETS = {
  DATABASE_URL: "postgres://owner:owner-password@db/openbrf",
  DATABASE_URL_RUNTIME: "postgres://app:app-password@db/openbrf",
  BETTER_AUTH_SECRET: "a-session-signing-secret-of-some-length",
  OPENBRF_ENCRYPTION_KEY: "an-encryption-key",
  OPENBRF_S3_SECRET_ACCESS_KEY: "an-object-store-secret",
  NPM_TOKEN: "a-registry-token",
  npm_config_registry: "https://registry.example.test/",
  NODE_OPTIONS: "--require /somewhere/else.js",
};

let directory: string;
let npmPath: string;
const saved = new Map<string, string | undefined>();

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openbrf-npm-install-"));
  npmPath = join(directory, "npm");
  await writeFile(
    npmPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > argv.txt\nenv > env.txt\n',
    "utf8",
  );
  await chmod(npmPath, 0o755);

  for (const [name, value] of Object.entries(HOST_SECRETS)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
});

afterEach(async () => {
  for (const [name, value] of saved) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  saved.clear();
  await rm(directory, { recursive: true, force: true });
});

async function recorded(): Promise<{
  argv: string[];
  env: Map<string, string>;
}> {
  const argv = (await readFile(join(directory, "argv.txt"), "utf8"))
    .split("\n")
    .filter((line) => line !== "");
  const env = new Map<string, string>();
  for (const line of (await readFile(join(directory, "env.txt"), "utf8")).split(
    "\n",
  )) {
    const equals = line.indexOf("=");
    if (equals > 0) {
      env.set(line.slice(0, equals), line.slice(equals + 1));
    }
  }
  return { argv, env };
}

describe("npmInstall", () => {
  it("installs offline, runs no scripts and leaves out peers", async () => {
    await npmInstall({ cwd: directory, npmPath });

    const { argv } = await recorded();
    expect(argv[0]).toBe("install");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--offline",
        "--ignore-scripts",
        "--omit=peer",
        "--legacy-peer-deps",
        "--omit=dev",
        "--omit=optional",
      ]),
    );
  });

  it("hands npm none of the host's secrets or npm configuration", async () => {
    await npmInstall({ cwd: directory, npmPath });

    const { env } = await recorded();
    for (const name of Object.keys(HOST_SECRETS)) {
      expect(env.has(name), name).toBe(false);
    }
    const values = [...env.values()].join("\n");
    for (const value of Object.values(HOST_SECRETS)) {
      expect(values).not.toContain(value);
    }
  });

  it("gives npm a cache and a home of its own inside the directory", async () => {
    await npmInstall({ cwd: directory, npmPath });

    const { env } = await recorded();
    expect(env.get("HOME")).toBe(directory);
    expect(env.get("npm_config_cache")).toBe(join(directory, ".npm-cache"));
    // Named so the host's files are not read, and never written.
    expect(env.get("npm_config_userconfig")?.startsWith(directory)).toBe(true);
    expect(env.get("npm_config_globalconfig")?.startsWith(directory)).toBe(
      true,
    );
  });

  it("gives npm no git to fetch a dependency with", async () => {
    await npmInstall({ cwd: directory, npmPath });

    const { env } = await recorded();
    expect(env.get("npm_config_git")).toBe(join(directory, ".git-unused"));
  });
});
