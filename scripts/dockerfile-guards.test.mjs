/**
 * The two build-time guards of the Dockerfile, run against trees that must
 * pass them and trees that must not.
 *
 * Run with `node --test scripts/dockerfile-guards.test.mjs`, from
 * `pnpm lint:guards`. It needs Docker: the guards use GNU find (`-xtype`) and
 * test for files owned by root, so they run as root in the base image the
 * Dockerfile names, on a fixture tree built inside the container. One
 * short-lived container (`--rm`, no network) per case. Without a reachable
 * Docker the tests are skipped locally and fail under CI.
 *
 * The guards are read out of the Dockerfile and run as written, so this file
 * holds no copy of their logic. The two things a case changes around them are
 * `pnpm` (the prune itself is not under test) and, where a case needs it,
 * `chmod` and `find`, stubbed before the guard runs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fromImagesOf } from "./check-image-pins.mjs";

const DOCKERFILE =
  process.env.DOCKERFILE_GUARDS_DOCKERFILE ??
  fileURLToPath(new URL("../Dockerfile", import.meta.url));
const source = readFileSync(DOCKERFILE, "utf8");

/**
 * The shell command of the RUN instruction that starts with `prefix`, as the
 * builder hands it to `/bin/sh -c`: continuation lines joined.
 *
 * @param {string} prefix
 * @returns {string}
 */
function runInstruction(prefix) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`RUN ${prefix}`));
  assert.notEqual(start, -1, `no RUN instruction starts with "${prefix}"`);
  const parts = [];
  for (let i = start; i < lines.length; i += 1) {
    const continued = lines[i].endsWith("\\");
    parts.push(continued ? lines[i].slice(0, -1) : lines[i]);
    if (!continued) break;
  }
  return parts.join(" ").replace(/^RUN /, "").trim();
}

const PRUNE_GUARD = runInstruction("pnpm prune --prod");
const PERMISSION_GUARD = runInstruction("find /app -not -type l -perm /022");
const IMAGE = fromImagesOf(source)[0];

const docker = spawnSync("docker", ["info"], { stdio: "ignore" });
const SKIP =
  docker.status === 0 || process.env.CI === "true"
    ? false
    : "Docker is not reachable; the guards run in the Dockerfile's base image";

/**
 * Builds the fixture with `setup`, then runs `guard` after `stubs`, all as
 * root in the base image.
 *
 * @param {{ setup: string, stubs?: string, guard: string, cwd?: string }} c
 * @returns {{ status: number | null, output: string }}
 */
function run({ setup, stubs = "", guard, cwd = "/work" }) {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--workdir",
      cwd,
      "--env",
      `SETUP=${setup}`,
      "--env",
      `STUBS=${stubs}`,
      "--env",
      `GUARD=${guard}`,
      IMAGE,
      "sh",
      "-c",
      'set -e; eval "$SETUP"; eval "$STUBS"; set +e; eval "$GUARD"',
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.error, undefined, String(result.error));
  return { status: result.status, output: result.stdout + result.stderr };
}

// --- the prune check ---------------------------------------------------------

/** A workspace as a prune leaves it: a virtual store and linked projects. */
const PRUNED = [
  "mkdir -p node_modules/.pnpm/zod@4.0.0/node_modules/zod packages/shared",
  "mkdir -p apps/api/node_modules apps/web/node_modules",
  "ln -s ../../../node_modules/.pnpm/zod@4.0.0/node_modules/zod apps/api/node_modules/zod",
].join(" && ");

const prune = (setup, stubs = "") =>
  run({ setup, stubs, guard: `pnpm() { :; }; ${PRUNE_GUARD}` });

test("a pruned tree passes the prune check", { skip: SKIP }, () => {
  const { status, output } = prune(PRUNED);
  assert.equal(status, 0, output);
});

for (const name of [
  "typescript@5.9.0",
  "vitest@3.0.0",
  "vite@7.0.0",
  "turbo@2.0.0",
  "@testing-library+react@16.0.0",
  "@vitejs+plugin-react@5.0.0",
  "@module-federation+vite@1.0.0",
]) {
  test(
    `${name} left in the virtual store fails the prune check`,
    { skip: SKIP },
    () => {
      const { status, output } = prune(
        `${PRUNED} && mkdir -p node_modules/.pnpm/${name}`,
      );
      assert.notEqual(status, 0, output);
    },
  );
}

test(
  "a link to a package the prune removed fails the prune check",
  { skip: SKIP },
  () => {
    const { status, output } = prune(
      `${PRUNED} && ln -s ../../../node_modules/.pnpm/vitest@3.0.0/node_modules/vitest apps/web/node_modules/vitest`,
    );
    assert.notEqual(status, 0, output);
  },
);

// The link into the store goes with the store, so that the dangling-link search
// has nothing to find and only the failed search can fail the check.
for (const [missing, removed] of [
  ["node_modules/.pnpm", "node_modules/.pnpm apps/api/node_modules/zod"],
  ["apps", "apps"],
  ["packages", "packages"],
]) {
  test(`a missing ${missing} fails the prune check`, { skip: SKIP }, () => {
    const { status, output } = prune(`${PRUNED} && rm -rf ${removed}`);
    assert.notEqual(status, 0, output);
  });
}

// --- the permission check ----------------------------------------------------

/** A tree as the build leaves it: owned by root, nothing others can write. */
const CLEAN = [
  "mkdir -p /app/apps/api/dist /app/node_modules/.pnpm",
  "echo x > /app/apps/api/dist/main.js",
  "chmod -R 0755 /app",
  "ln -s ../../missing /app/apps/api/link",
  "chown -R root:root /app",
].join(" && ");

const permissions = (setup, stubs = "") =>
  run({ setup, stubs, guard: PERMISSION_GUARD, cwd: "/" });

// A `chmod` that changes nothing, ahead of the real one on PATH (find runs it
// as a program, not as a shell function), so the first find cannot repair what
// the second is there to catch.
const NO_CHMOD =
  "mkdir /stub && printf '#!/bin/sh\\nexit 0\\n' > /stub/chmod && chmod 0755 /stub/chmod && PATH=/stub:$PATH";

test("a root-owned tree passes the permission check", { skip: SKIP }, () => {
  const { status, output } = permissions(CLEAN);
  assert.equal(status, 0, output);
});

test(
  "symlinks, which are always 0777, pass the permission check",
  { skip: SKIP },
  () => {
    const { status, output } = permissions(CLEAN);
    assert.equal(status, 0, output);
  },
);

test(
  "write bits on an entry are removed rather than refused",
  { skip: SKIP },
  () => {
    const { status, output } = permissions(
      `${CLEAN} && chmod 0666 /app/apps/api/dist/main.js && chmod 0777 /app/apps/api`,
    );
    assert.equal(status, 0, output);
  },
);

test(
  "a file others can write that the repair does not reach fails",
  { skip: SKIP },
  () => {
    const { status, output } = permissions(
      `${CLEAN} && chmod 0666 /app/apps/api/dist/main.js`,
      NO_CHMOD,
    );
    assert.notEqual(status, 0, output);
  },
);

test(
  "a directory the group can write that the repair does not reach fails",
  { skip: SKIP },
  () => {
    const { status, output } = permissions(
      `${CLEAN} && chmod 0775 /app/node_modules/.pnpm`,
      NO_CHMOD,
    );
    assert.notEqual(status, 0, output);
  },
);

test("an entry not owned by root fails", { skip: SKIP }, () => {
  const { status, output } = permissions(
    `${CLEAN} && chown node:node /app/apps/api/dist/main.js`,
  );
  assert.notEqual(status, 0, output);
});

test(
  "a verification search that errors with no output fails",
  { skip: SKIP },
  () => {
    // The repair succeeds and the tree is clean; only the second find, the one
    // that tests ownership, fails, the way a search does that cannot read part
    // of the tree.
    const { status, output } = permissions(
      CLEAN,
      'find() { case " $* " in *" -user "*) echo "find: cannot read" >&2; return 1;; esac; command find "$@"; }',
    );
    assert.notEqual(status, 0, output);
  },
);

test("a missing /app fails the permission check", { skip: SKIP }, () => {
  const { status, output } = permissions("true");
  assert.notEqual(status, 0, output);
});
