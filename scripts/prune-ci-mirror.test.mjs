/**
 * What is pruned from the CI image mirror, and what never is.
 *
 * The packages API and skopeo are replaced by one stub of the registry, which
 * both read and change, so that a test can have another run tag a copy in
 * the middle of a prune. Run with `node --test` from `pnpm lint:guards`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { digestTag, mirrorImages } from "./ci-images.mjs";
import { githubClient, prunePlan, pruneMirror } from "./prune-ci-mirror.mjs";

const MIRROR = "ghcr.io/openbrf/ci-mirror";

/** Manifests by digest, so that a copy can be checked against its digest. */
const MANIFESTS = new Map();
const manifest = (text) => {
  const bytes = Buffer.from(text);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  MANIFESTS.set(digest, bytes);
  return digest;
};
const PINNED = manifest('{"pinned":true}');
const OLD = manifest('{"old":true}');
const OTHER = manifest('{"other":true}');
const SHARED = manifest('{"shared":true}');
const IMAGES = [{ name: "postgres", upstream: `postgres:18-alpine@${PINNED}` }];
/** A branch's pin of `digest`, under the same tag as the default branch's. */
const pinOf = (digest) => [
  { name: "postgres", upstream: `postgres:18-alpine@${digest}` },
];

const version = (id, name, ...tags) => ({ id, name, tags });
const names = (versions) => versions.map(({ name }) => name);

test("a version only closed pull requests hold is deleted", () => {
  const doomed = prunePlan(
    [version(1, OLD, "pr-4"), version(2, OTHER, "pr-5", "pr-6")],
    PINNED,
    () => true,
  );
  assert.deepEqual(names(doomed), [OLD, OTHER]);
});

test("a version an open pull request holds is kept", () => {
  const doomed = prunePlan(
    [version(1, OLD, "pr-4"), version(2, OTHER, "pr-5", "pr-6")],
    PINNED,
    (number) => number !== 6,
  );
  assert.deepEqual(names(doomed), [OLD]);
});

test("a version with any tag but a pull request's is kept", () => {
  const doomed = prunePlan(
    [
      version(1, OLD, "pr-4", "18-alpine"),
      version(2, OTHER, "pr-007"),
      version(3, SHARED, "pr-5x"),
      version(4, SHARED, "pr-6", digestTag(SHARED)),
    ],
    PINNED,
    () => true,
  );
  assert.deepEqual(doomed, []);
});

test("an untagged version is kept", () => {
  assert.deepEqual(
    prunePlan([version(1, OLD)], PINNED, () => true),
    [],
  );
});

test("the pinned digest is never deleted, though pull requests' tags alone hold it", () => {
  const doomed = prunePlan(
    [version(1, PINNED, "pr-4"), version(2, OLD, "pr-4")],
    PINNED,
    () => true,
  );
  assert.deepEqual(names(doomed), [OLD]);
});

const ok = (stdout = Buffer.alloc(0)) => ({ status: 0, stdout, stderr: "" });
const failed = (stderr) => ({ status: 1, stdout: Buffer.alloc(0), stderr });

/**
 * The mirror's packages, `{ postgres: [version...] }`, and the pull requests
 * in `closedPulls`, as both the packages API and skopeo see them. A tag is on
 * one version of a package at a time, as in the registry, and a version gone
 * takes its tags with it.
 */
function registry(packages, closedPulls = new Set()) {
  const store = new Map(
    Object.entries(packages).map(([name, versions]) => [
      `ci-mirror/${name}`,
      versions.map((entry) => ({ ...entry, tags: [...entry.tags] })),
    ]),
  );
  let nextId = 1000;
  const deleted = [];
  const asked = [];
  const calls = [];
  const versionsOf = (name) => {
    if (!store.has(name)) {
      store.set(name, []);
    }
    return store.get(name);
  };
  const copyOf = (entry) => ({ ...entry, tags: [...entry.tags] });
  const client = {
    versions: async (owner, name) => versionsOf(name).map(copyOf),
    version: async (owner, name, id) => {
      const found = versionsOf(name).find((entry) => entry.id === id);
      if (found === undefined) {
        throw new Error(`GET ${name}/${id} answered 404: Not Found`);
      }
      return copyOf(found);
    },
    deleteVersion: async (owner, name, id) => {
      store.set(
        name,
        versionsOf(name).filter((entry) => entry.id !== id),
      );
      deleted.push(`${name}#${id}`);
    },
    closed: async (repository, number) => {
      asked.push(`${repository}#${number}`);
      return closedPulls.has(number);
    },
  };
  /** The package and digest of `docker://ghcr.io/openbrf/ci-mirror/x@d`. */
  const inMirror = (reference) => {
    const match = new RegExp(
      `^docker://${MIRROR.replace(/[\\./]/g, "\\$&")}/([^@:]+)(?:@(.+)|:(.+))$`,
    ).exec(reference);
    return (
      match && {
        name: `ci-mirror/${match[1]}`,
        digest: match[2],
        tag: match[3],
      }
    );
  };
  const runner = (program, args) => {
    calls.push([program, ...args].join(" "));
    if (args[0] === "inspect") {
      const { name, digest, tag } = inMirror(args.at(-1));
      const found = versionsOf(name).find((entry) =>
        digest === undefined ? entry.tags.includes(tag) : entry.name === digest,
      );
      return found === undefined
        ? failed("manifest unknown")
        : ok(MANIFESTS.get(found.name));
    }
    const source = args.at(-2);
    const digest = source.split("@")[1];
    const from = inMirror(source);
    if (
      from !== null &&
      !versionsOf(from.name).some((entry) => entry.name === digest)
    ) {
      return failed("manifest unknown");
    }
    const { name, tag } = inMirror(args.at(-1));
    const versions = versionsOf(name);
    for (const entry of versions) {
      entry.tags = entry.tags.filter((held) => held !== tag);
    }
    let target = versions.find((entry) => entry.name === digest);
    if (target === undefined) {
      target = { id: nextId++, name: digest, tags: [] };
      versions.push(target);
    }
    target.tags.push(tag);
    return ok();
  };
  return {
    client,
    runner,
    deleted,
    asked,
    calls,
    tagsOf: (image, digest) =>
      versionsOf(`ci-mirror/${image}`).find((entry) => entry.name === digest)
        ?.tags,
  };
}

/** pruneMirror on `mirror`. */
function prune(mirror, images, options = {}) {
  return pruneMirror(images, MIRROR, {
    client: mirror.client,
    repository: "openbrf/openbrf",
    log: () => {},
    ...options,
  });
}

/**
 * What .github/workflows/ci-images.yml runs for a branch other than the
 * default one, whose pins are `images`: the mirror step, without waiting a
 * minute after tagging unless `sleep` says what happens meanwhile.
 */
function branchRun(mirror, images, sleep = () => {}) {
  return mirrorImages(images, MIRROR, {
    runner: mirror.runner,
    sleep,
    log: () => {},
  });
}

const copies = (calls) => calls.filter((call) => call.includes(" copy "));

test("the default branch's pin is kept though pull requests' tags alone hold it, and its mirror step tags it", async () => {
  const mirror = registry(
    {
      postgres: [
        version(1, PINNED, "pr-4"),
        version(2, OLD, "pr-4"),
        version(3, OTHER),
      ],
    },
    new Set([4]),
  );
  assert.deepEqual(await prune(mirror, IMAGES, { remove: true }), []);
  assert.deepEqual(copies(mirror.calls), []);
  assert.deepEqual(mirror.deleted, ["ci-mirror/postgres#2"]);
  assert.deepEqual(mirror.tagsOf("postgres", OTHER), []);

  assert.deepEqual(branchRun(mirror, IMAGES), []);
  assert.deepEqual(copies(mirror.calls), [
    `skopeo copy --all --preserve-digests docker://${MIRROR}/postgres@${PINNED} docker://${MIRROR}/postgres:${digestTag(PINNED)}`,
  ]);
  assert.deepEqual(mirror.tagsOf("postgres", PINNED), [
    "pr-4",
    digestTag(PINNED),
  ]);
});

test("without --delete nothing is deleted or tagged", async () => {
  const mirror = registry(
    { postgres: [version(1, PINNED, "pr-4"), version(2, OLD, "pr-4")] },
    new Set([4]),
  );
  const lines = [];
  await prune(mirror, IMAGES, { log: (line) => lines.push(line) });
  assert.deepEqual(copies(mirror.calls), []);
  assert.deepEqual(mirror.deleted, []);
  assert.match(
    lines.join("\n"),
    new RegExp(`Would delete .*postgres@${OLD} \\(pr-4\\)`),
  );
});

test("each pull request is looked up once, and not for a pinned or tagged copy", async () => {
  const mirror = registry({
    postgres: [
      version(1, PINNED, "pr-9"),
      version(2, OLD, "pr-4"),
      version(3, OTHER, "pr-4", "pr-5"),
      version(4, SHARED, "18-alpine", "pr-6"),
    ],
  });
  await prune(mirror, IMAGES, { remove: true });
  assert.deepEqual(mirror.asked, ["openbrf/openbrf#4", "openbrf/openbrf#5"]);
});

test("an image whose versions cannot be read is reported and the other images go on", async () => {
  const mirror = registry(
    { postgres: [version(1, OLD, "pr-4")], node: [version(2, OLD, "pr-4")] },
    new Set([4]),
  );
  const failures = await prune(
    mirror,
    [...IMAGES, { name: "node", upstream: `node:24-alpine@${OTHER}` }],
    {
      remove: true,
      client: {
        ...mirror.client,
        versions: async (owner, name) => {
          if (name === "ci-mirror/postgres") {
            throw new Error("GET answered 403: Forbidden");
          }
          return mirror.client.versions(owner, name);
        },
      },
    },
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /ci-mirror\/postgres: GET answered 403/);
  assert.deepEqual(mirror.deleted, ["ci-mirror/node#2"]);
});

test("a pull request that uses the copy another one made keeps it when that one closes", async () => {
  // Pull request 11 had SHARED copied; pull request 22, still open, pins it
  // too, and the mirror has it already.
  const packages = {
    postgres: [version(1, PINNED, "18-alpine"), version(7, SHARED, "pr-11")],
  };

  const unregistered = registry(packages, new Set([11]));
  await prune(unregistered, IMAGES, { remove: true });
  assert.deepEqual(unregistered.deleted, ["ci-mirror/postgres#7"]);

  const mirror = registry(packages, new Set([11]));
  assert.deepEqual(
    mirrorImages(pinOf(SHARED), MIRROR, {
      tag: "pr-22",
      runner: mirror.runner,
      sleep: () => {},
      log: () => {},
    }),
    [],
  );
  assert.deepEqual(mirror.tagsOf("postgres", SHARED), ["pr-11", "pr-22"]);
  assert.deepEqual(await prune(mirror, IMAGES, { remove: true }), []);
  assert.deepEqual(mirror.deleted, []);
  assert.deepEqual(mirror.asked, ["openbrf/openbrf#11", "openbrf/openbrf#22"]);
});

test("a branch's copy stays when another branch pins another digest under the same tag", async () => {
  // The default branch pins PINNED as 18-alpine, and pull request 11 had
  // SHARED copied. A branch adopts SHARED, as 18-alpine too; then another
  // branch pins OTHER as 18-alpine. Pull request 11 closes while the first
  // branch has not merged yet, and the default branch prunes.
  const closed = new Set();
  const mirror = registry(
    {
      postgres: [version(1, PINNED, "18-alpine"), version(7, SHARED, "pr-11")],
    },
    closed,
  );
  assert.deepEqual(branchRun(mirror, pinOf(SHARED)), []);
  assert.deepEqual(branchRun(mirror, pinOf(OTHER)), []);
  closed.add(11);
  assert.deepEqual(await prune(mirror, IMAGES, { remove: true }), []);
  assert.deepEqual(mirror.deleted, []);
  assert.deepEqual(mirror.tagsOf("postgres", SHARED), [
    "pr-11",
    digestTag(SHARED),
  ]);
  assert.deepEqual(mirror.tagsOf("postgres", OTHER), [digestTag(OTHER)]);
  // Neither branch moved the tag the default branch's copy has.
  assert.deepEqual(mirror.tagsOf("postgres", PINNED), ["18-alpine"]);
});

test("a copy a branch made stays when a pull request also uses it and closes", async () => {
  // A branch has SHARED copied; pull request 11 pins it too, and tags it;
  // another branch pins OTHER under the same tag; pull request 11 closes.
  const closed = new Set();
  const mirror = registry(
    { postgres: [version(1, PINNED, "18-alpine")] },
    closed,
  );
  assert.deepEqual(branchRun(mirror, pinOf(SHARED)), []);
  assert.deepEqual(
    mirrorImages(pinOf(SHARED), MIRROR, {
      tag: "pr-11",
      runner: mirror.runner,
      sleep: () => {},
      log: () => {},
    }),
    [],
  );
  assert.deepEqual(branchRun(mirror, pinOf(OTHER)), []);
  closed.add(11);
  assert.deepEqual(await prune(mirror, IMAGES, { remove: true }), []);
  assert.deepEqual(mirror.deleted, []);
  assert.deepEqual(mirror.tagsOf("postgres", SHARED), [
    digestTag(SHARED),
    "pr-11",
  ]);
});

test("a copy another branch tags between the listing and the deletion is kept", async () => {
  // A branch adopts SHARED, which only closed pull request 11's tag holds,
  // while the default branch's prune, which does not pin it, runs.
  const packages = {
    postgres: [version(1, PINNED, "18-alpine"), version(7, SHARED, "pr-11")],
  };

  const alone = registry(packages, new Set([11]));
  await prune(alone, IMAGES, { remove: true });
  assert.deepEqual(alone.deleted, ["ci-mirror/postgres#7"]);

  const mirror = registry(packages, new Set([11]));
  const lines = [];
  const failures = await prune(mirror, IMAGES, {
    remove: true,
    log: (line) => lines.push(line),
    client: {
      ...mirror.client,
      // The branch's whole run happens once the default branch has listed.
      versions: async (owner, name) => {
        const listed = await mirror.client.versions(owner, name);
        assert.deepEqual(branchRun(mirror, pinOf(SHARED)), []);
        return listed;
      },
    },
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(mirror.deleted, []);
  assert.deepEqual(mirror.tagsOf("postgres", SHARED), [
    "pr-11",
    digestTag(SHARED),
  ]);
  assert.match(
    lines.join("\n"),
    new RegExp(`Kept .*pr-11\\): its tags are pr-11, ${digestTag(SHARED)} now`),
  );
});

test("a deletion is given up when reading the tags again takes too long", async () => {
  const mirror = registry(
    { postgres: [version(1, PINNED, "18-alpine"), version(2, OLD, "pr-4")] },
    new Set([4]),
  );
  let clock = 0;
  await prune(mirror, IMAGES, {
    remove: true,
    now: () => clock,
    client: {
      ...mirror.client,
      version: async (...args) => {
        clock += 10_001;
        return mirror.client.version(...args);
      },
    },
  });
  assert.deepEqual(mirror.deleted, []);

  clock = 0;
  await prune(mirror, IMAGES, {
    remove: true,
    now: () => clock,
    client: {
      ...mirror.client,
      version: async (...args) => {
        clock += 10_000;
        return mirror.client.version(...args);
      },
    },
  });
  assert.deepEqual(mirror.deleted, ["ci-mirror/postgres#2"]);
});

test("a branch's copy deleted as it was tagged is copied again after the wait", async () => {
  // The default branch's prune read the tags just before the branch tagged
  // the copy, and deleted it just after.
  const mirror = registry({
    postgres: [version(1, SHARED, "pr-4"), version(2, OLD, "pr-4")],
  });
  const slept = [];
  const failures = branchRun(mirror, pinOf(SHARED), (ms) => {
    slept.push(ms);
    mirror.client.deleteVersion("openbrf", "ci-mirror/postgres", 1);
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(slept, [60_000, 60_000]);
  assert.equal(
    copies(mirror.calls).at(-1),
    `skopeo copy --all --preserve-digests --retry-times 3 docker://docker.io/library/postgres@${SHARED} docker://${MIRROR}/postgres:${digestTag(SHARED)}`,
  );
  assert.deepEqual(mirror.tagsOf("postgres", SHARED), [digestTag(SHARED)]);
});

test("a pull request whose tag a prune deleted keeps the copy another one made again", async () => {
  // Pull request 11, closed, had SHARED copied. Pull request 33, open, tags
  // it pr-33 as the default branch's prune, which read pr-11 alone, deletes
  // it; pull request 22 then has it copied again, under pr-22, before pull
  // request 33 checks it.
  const closed = new Set([11]);
  const mirror = registry(
    {
      postgres: [version(1, PINNED, "18-alpine"), version(7, SHARED, "pr-11")],
    },
    closed,
  );
  const mirrorFor = (number, sleep) =>
    mirrorImages(pinOf(SHARED), MIRROR, {
      tag: `pr-${number}`,
      runner: mirror.runner,
      sleep,
      log: () => {},
    });
  let pr33 = [];
  let waits = 0;
  assert.deepEqual(
    await prune(mirror, IMAGES, {
      remove: true,
      client: {
        ...mirror.client,
        deleteVersion: async (...args) => {
          pr33 = mirrorFor(33, () => {
            waits += 1;
            if (waits === 1) {
              mirror.client.deleteVersion(...args);
              assert.deepEqual(
                mirrorFor(22, () => {}),
                [],
              );
            }
          });
        },
      },
    }),
    [],
  );
  assert.deepEqual(pr33, []);
  assert.deepEqual(mirror.deleted, ["ci-mirror/postgres#7"]);
  assert.deepEqual(mirror.tagsOf("postgres", SHARED), ["pr-22", "pr-33"]);

  // Pull request 22 closes; pull request 33 is still open, and needs SHARED.
  closed.add(22);
  assert.deepEqual(await prune(mirror, IMAGES, { remove: true }), []);
  assert.deepEqual(mirror.deleted, ["ci-mirror/postgres#7"]);
  assert.deepEqual(mirror.tagsOf("postgres", SHARED), ["pr-22", "pr-33"]);
});

test("a branch whose pin's tag a prune deleted keeps the copy a pull request made again", async () => {
  // A branch pins SHARED, which closed pull request 11's tag alone holds. It
  // tags the copy with its digest as the default branch's prune deletes it,
  // and pull request 22 has it copied again before the branch checks it.
  const branchPins = [
    { name: "postgres", upstream: `postgres:18.1-alpine@${SHARED}` },
  ];
  const closed = new Set([11]);
  const mirror = registry(
    {
      postgres: [version(1, PINNED, "18-alpine"), version(7, SHARED, "pr-11")],
    },
    closed,
  );
  let waits = 0;
  assert.deepEqual(
    branchRun(mirror, branchPins, () => {
      waits += 1;
      if (waits === 1) {
        mirror.client.deleteVersion("openbrf", "ci-mirror/postgres", 7);
        assert.deepEqual(
          mirrorImages(branchPins, MIRROR, {
            tag: "pr-22",
            runner: mirror.runner,
            sleep: () => {},
            log: () => {},
          }),
          [],
        );
      }
    }),
    [],
  );
  assert.deepEqual(mirror.tagsOf("postgres", SHARED), [
    "pr-22",
    digestTag(SHARED),
  ]);

  // Pull request 22 closes before the branch merges.
  closed.add(22);
  assert.deepEqual(await prune(mirror, IMAGES, { remove: true }), []);
  assert.deepEqual(mirror.tagsOf("postgres", SHARED), [
    "pr-22",
    digestTag(SHARED),
  ]);
});

test("a mirror outside ghcr.io cannot be pruned", async () => {
  const mirror = registry({});
  const failures = await pruneMirror(
    IMAGES,
    "registry.example/openbrf/mirror",
    {
      client: mirror.client,
      repository: "openbrf/openbrf",
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

test("the client reads one version as it is now", async () => {
  const { fetchFn } = api({
    "GET /orgs/openbrf/packages/container/ci-mirror%2Fpostgres/versions/7": {
      id: 7,
      name: OLD,
      metadata: { container: { tags: ["pr-4", "18-alpine"] } },
    },
  });
  const client = githubClient({ token: "t", fetchFn });
  assert.deepEqual(await client.version("openbrf", "ci-mirror/postgres", 7), {
    id: 7,
    name: OLD,
    tags: ["pr-4", "18-alpine"],
  });
  await assert.rejects(
    client.version("openbrf", "ci-mirror/postgres", 8),
    /versions\/8 answered 404/,
  );
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
