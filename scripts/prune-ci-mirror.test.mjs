/**
 * What is pruned from the CI image mirror, and what never is.
 *
 * The packages API and skopeo are replaced by stubs that answer the way each
 * test says. Run with `node --test` from `pnpm lint:guards`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { githubClient, prunePlan, pruneMirror } from "./prune-ci-mirror.mjs";

const MIRROR = "ghcr.io/openbrf/ci-mirror";
const PINNED = `sha256:${"a".repeat(64)}`;
const OLD = `sha256:${"b".repeat(64)}`;
const OTHER = `sha256:${"c".repeat(64)}`;
const IMAGES = [{ name: "postgres", upstream: `postgres:18-alpine@${PINNED}` }];

const version = (id, name, ...tags) => ({ id, name, tags });
const names = (versions) => versions.map(({ name }) => name);

test("a version only closed pull requests hold is deleted", () => {
  const plan = prunePlan(
    [version(1, OLD, "pr-4"), version(2, OTHER, "pr-5", "pr-6")],
    PINNED,
    () => true,
  );
  assert.deepEqual(names(plan.remove), [OLD, OTHER]);
  assert.equal(plan.retag, false);
});

test("a version an open pull request holds is kept", () => {
  const plan = prunePlan(
    [version(1, OLD, "pr-4"), version(2, OTHER, "pr-5", "pr-6")],
    PINNED,
    (number) => number !== 6,
  );
  assert.deepEqual(names(plan.remove), [OLD]);
});

test("a version with any tag but a pull request's is kept", () => {
  const plan = prunePlan(
    [
      version(1, OLD, "pr-4", "18-alpine"),
      version(2, OTHER, "pr-007"),
      version(3, `sha256:${"d".repeat(64)}`, "pr-5x"),
    ],
    PINNED,
    () => true,
  );
  assert.deepEqual(plan.remove, []);
});

test("an untagged version is kept", () => {
  const plan = prunePlan([version(1, OLD)], PINNED, () => true);
  assert.deepEqual(plan.remove, []);
});

test("the only copy of the pinned digest is tagged, never deleted", () => {
  const plan = prunePlan(
    [version(1, PINNED, "pr-4"), version(2, OLD, "pr-4")],
    PINNED,
    () => true,
  );
  assert.equal(plan.retag, true);
  assert.deepEqual(names(plan.remove), [OLD]);
});

test("a pinned digest that has a tag of its own needs no new one", () => {
  const plan = prunePlan(
    [version(1, PINNED, "18-alpine", "pr-4")],
    PINNED,
    () => true,
  );
  assert.equal(plan.retag, false);
  assert.deepEqual(plan.remove, []);
});

/** A mirror whose package holds `versions`, and the pull requests in `closed`. */
function stubs(versions, closedPulls) {
  const deleted = [];
  const asked = [];
  const client = {
    versions: async () => versions,
    deleteVersion: async (owner, name, id) => deleted.push(`${name}#${id}`),
    closed: async (repository, number) => {
      asked.push(`${repository}#${number}`);
      return closedPulls.has(number);
    },
  };
  const calls = [];
  const runner = (program, args) => {
    calls.push([program, ...args].join(" "));
    return { status: 0, stdout: Buffer.alloc(0), stderr: "" };
  };
  return { client, deleted, asked, calls, runner };
}

test("the pin's only copy is tagged with the pin's tag before anything is deleted", async () => {
  const { client, deleted, calls, runner } = stubs(
    [version(1, PINNED, "pr-4"), version(2, OLD, "pr-4"), version(3, OTHER)],
    new Set([4]),
  );
  const failures = await pruneMirror(IMAGES, MIRROR, {
    client,
    repository: "openbrf/openbrf",
    remove: true,
    runner,
    log: () => {},
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(calls, [
    `skopeo copy --all --preserve-digests docker://${MIRROR}/postgres@${PINNED} docker://${MIRROR}/postgres:18-alpine`,
  ]);
  assert.deepEqual(deleted, ["ci-mirror/postgres#2"]);
});

test("without --delete only the pin is tagged", async () => {
  const { client, deleted, calls, runner } = stubs(
    [version(1, PINNED, "pr-4"), version(2, OLD, "pr-4")],
    new Set([4]),
  );
  const lines = [];
  await pruneMirror(IMAGES, MIRROR, {
    client,
    repository: "openbrf/openbrf",
    runner,
    log: (line) => lines.push(line),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(deleted, []);
  assert.match(lines.join("\n"), /Would delete .*postgres@sha256:b+ \(pr-4\)/);
});

test("each pull request is looked up once, and not for a pinned or tagged copy", async () => {
  const { client, asked, runner } = stubs(
    [
      version(1, PINNED, "pr-9"),
      version(2, OLD, "pr-4"),
      version(3, OTHER, "pr-4", "pr-5"),
      version(4, `sha256:${"d".repeat(64)}`, "18-alpine", "pr-6"),
    ],
    new Set(),
  );
  await pruneMirror(IMAGES, MIRROR, {
    client,
    repository: "openbrf/openbrf",
    remove: true,
    runner,
    log: () => {},
  });
  assert.deepEqual(asked, ["openbrf/openbrf#4", "openbrf/openbrf#5"]);
});

test("a failed tagging is reported and the other images go on", async () => {
  const { client, deleted } = stubs(
    [version(1, PINNED, "pr-4"), version(2, OLD, "pr-4")],
    new Set([4]),
  );
  const failures = await pruneMirror(
    [...IMAGES, { name: "node", upstream: `node:24-alpine@${OTHER}` }],
    MIRROR,
    {
      client,
      repository: "openbrf/openbrf",
      remove: true,
      runner: () => ({
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: "denied",
      }),
      log: () => {},
    },
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /postgres.*could not be tagged 18-alpine: denied/);
  // The copy of the pin was not tagged, so nothing of its package was deleted.
  assert.equal(deleted.filter((entry) => entry.includes("postgres")).length, 0);
});

test("a mirror outside ghcr.io cannot be pruned", async () => {
  const { client, runner } = stubs([], new Set());
  const failures = await pruneMirror(
    IMAGES,
    "registry.example/openbrf/mirror",
    {
      client,
      repository: "openbrf/openbrf",
      runner,
      log: () => {},
    },
  );
  assert.match(failures[0], /only a package of an organization on ghcr\.io/);
});

/** A fetch that answers from `routes`, keyed by `METHOD path`. */
function api(routes) {
  const seen = [];
  const fetchFn = async (url, { method, headers }) => {
    const key = `${method} ${url.replace("https://api.github.com", "")}`;
    seen.push({ key, headers });
    const answer = routes[key];
    if (answer === undefined) {
      return { ok: false, status: 404, text: async () => "Not Found" };
    }
    return {
      ok: true,
      status: answer === null ? 204 : 200,
      json: async () => answer,
    };
  };
  return { fetchFn, seen };
}

test("the client reads every page of versions, with the tags of each", async () => {
  const page = (from, count) =>
    Array.from({ length: count }, (_, index) => ({
      id: from + index,
      name: OLD,
      metadata: { container: { tags: index === 0 ? ["pr-4"] : [] } },
    }));
  const { fetchFn, seen } = api({
    "GET /orgs/openbrf/packages/container/ci-mirror%2Fpostgres/versions?per_page=100&page=1":
      page(1, 100),
    "GET /orgs/openbrf/packages/container/ci-mirror%2Fpostgres/versions?per_page=100&page=2":
      page(101, 3),
  });
  const versions = await githubClient({ token: "t", fetchFn }).versions(
    "openbrf",
    "ci-mirror/postgres",
  );
  assert.equal(versions.length, 103);
  assert.deepEqual(versions[0].tags, ["pr-4"]);
  assert.deepEqual(versions[1].tags, []);
  assert.equal(seen[0].headers.Authorization, "Bearer t");
});

test("the client deletes a version, and says when the API refuses", async () => {
  const { fetchFn, seen } = api({
    "DELETE /orgs/openbrf/packages/container/ci-mirror%2Fpostgres/versions/7":
      null,
  });
  const client = githubClient({ token: "t", fetchFn });
  await client.deleteVersion("openbrf", "ci-mirror/postgres", 7);
  assert.equal(seen.length, 1);
  await assert.rejects(
    client.deleteVersion("openbrf", "ci-mirror/postgres", 8),
    /versions\/8 answered 404: Not Found/,
  );
});

test("only a pull request the API calls closed is closed", async () => {
  const { fetchFn } = api({
    "GET /repos/openbrf/openbrf/pulls/1": { state: "closed" },
    "GET /repos/openbrf/openbrf/pulls/2": { state: "open" },
  });
  const client = githubClient({ token: "t", fetchFn });
  assert.equal(await client.closed("openbrf/openbrf", 1), true);
  assert.equal(await client.closed("openbrf/openbrf", 2), false);
  await assert.rejects(client.closed("openbrf/openbrf", 3), /answered 404/);
});
