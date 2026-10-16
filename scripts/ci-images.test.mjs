/**
 * What CI pulls instead of a metered registry, and how the mirror is filled.
 *
 * skopeo is replaced by a stub that answers the way each test says. Run with
 * `node --test` from `pnpm lint:guards`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PIN_FILES,
  SETTLE_MS,
  ciImages,
  digestTag,
  hubImage,
  keepTagged,
  mirrorImages,
  pullRefOf,
  selectImages,
  settleMsOf,
  sourcesOf,
  waitForMirror,
} from "./ci-images.mjs";

/** A manifest, and the digest it hashes to. */
const MANIFEST = Buffer.from('{"schemaVersion":2}');
const DIGEST = `sha256:${createHash("sha256").update(MANIFEST).digest("hex")}`;
/** A second manifest, so that a pull request can propose another digest. */
const OTHER_MANIFEST = Buffer.from('{"schemaVersion":2,"other":true}');
const OTHER_DIGEST = `sha256:${createHash("sha256").update(OTHER_MANIFEST).digest("hex")}`;
const PIN = `postgres:18-alpine@${DIGEST}`;
const MIRROR = "ghcr.io/openbrf/ci-mirror";

const ok = (stdout = Buffer.alloc(0)) => ({ status: 0, stdout, stderr: "" });
const failed = (stderr) => ({ status: 1, stdout: Buffer.alloc(0), stderr });

/**
 * A skopeo that serves MANIFEST from every repository in `serving` by digest,
 * and under the tags in `tagged` (`repository:tag`) or copied to, and copies
 * from a source unless `refusing` names it. Records each call.
 */
function registry({
  serving = new Set(),
  tagged = new Set(),
  refusing = new Set(),
} = {}) {
  const calls = [];
  const untagged = (reference) => reference.replace(/:[^/:]+$/, "");
  const runner = (program, args) => {
    calls.push([program, ...args].join(" "));
    if (args[0] === "inspect") {
      const reference = args[2].slice("docker://".length);
      const repository = untagged(reference.split("@")[0]);
      return serving.has(repository) &&
        (reference.includes("@") || tagged.has(reference))
        ? ok(MANIFEST)
        : failed("manifest unknown");
    }
    const source = args.at(-2).slice("docker://".length).split("@")[0];
    if (refusing.has(source)) {
      return failed(`toomanyrequests from ${source}`);
    }
    const target = args.at(-1).slice("docker://".length);
    serving.add(untagged(target));
    tagged.add(target);
    return ok();
  };
  return { runner, calls };
}

test("an official image is read from any registry that serves it", () => {
  for (const reference of [
    PIN,
    `library/${PIN}`,
    `docker.io/library/${PIN}`,
    `docker.io/${PIN}`,
    `public.ecr.aws/docker/library/${PIN}`,
    `mirror.gcr.io/library/${PIN}`,
  ]) {
    assert.deepEqual(hubImage(reference), {
      repository: "library/postgres",
      name: "postgres",
      tag: "18-alpine",
      digest: DIGEST,
    });
  }
});

test("an image of another Docker Hub namespace keeps it", () => {
  for (const reference of [
    `semgrep/semgrep:1.2.3@${DIGEST}`,
    `docker.io/semgrep/semgrep:1.2.3@${DIGEST}`,
    `mirror.gcr.io/semgrep/semgrep:1.2.3@${DIGEST}`,
  ]) {
    assert.deepEqual(hubImage(reference), {
      repository: "semgrep/semgrep",
      name: "semgrep",
      tag: "1.2.3",
      digest: DIGEST,
    });
  }
});

test("an image that is not a Docker Hub one pinned by digest is refused", () => {
  for (const reference of [
    "postgres:18-alpine",
    `postgres@${DIGEST}`,
    `ghcr.io/axllent/mailpit:v1@${DIGEST}`,
    `public.ecr.aws/someone/postgres:18-alpine@${DIGEST}`,
    `public.ecr.aws/docker/semgrep/semgrep:1.2.3@${DIGEST}`,
    `evil.example/library/postgres:18-alpine@${DIGEST}`,
    `evil.example/postgres:18-alpine@${DIGEST}`,
    `localhost/postgres:18-alpine@${DIGEST}`,
    `a/b/postgres:18-alpine@${DIGEST}`,
    `postgres:18-alpine@${DIGEST} --privileged`,
    `postgres:18-alpine@${DIGEST}\nFROM evil`,
  ]) {
    assert.throws(() => hubImage(reference), /not a Docker Hub image/);
  }
});

test("an official image is copied from Amazon's copy as well, another one is not", () => {
  assert.deepEqual(sourcesOf("library/postgres"), [
    "docker.io/library/postgres",
    "public.ecr.aws/docker/library/postgres",
    "mirror.gcr.io/library/postgres",
  ]);
  assert.deepEqual(sourcesOf("semgrep/semgrep"), [
    "docker.io/semgrep/semgrep",
    "mirror.gcr.io/semgrep/semgrep",
  ]);
});

test("the copy keeps the name, tag and digest and changes the registry", () => {
  assert.equal(
    pullRefOf(`public.ecr.aws/docker/library/${PIN}`, MIRROR),
    `${MIRROR}/${PIN}`,
  );
  assert.equal(
    pullRefOf(`semgrep/semgrep:1.2.3@${DIGEST}`, MIRROR),
    `${MIRROR}/semgrep:1.2.3@${DIGEST}`,
  );
});

test("without a mirror the pin itself is pulled", () => {
  assert.equal(pullRefOf(PIN, undefined), PIN);
  assert.equal(pullRefOf(PIN, ""), PIN);
});

test("a mirror that is not a registry path is refused", () => {
  for (const mirror of ["ghcr.io", "ghcr.io/openbrf/ci-mirror:tag", "x y/z"]) {
    assert.throws(() => pullRefOf(PIN, mirror), /OPENBRF_IMAGE_MIRROR/);
  }
});

const NODE = `public.ecr.aws/docker/library/node:26-slim@${DIGEST}`;
const SEMGREP = `semgrep/semgrep:1.2.3@${DIGEST}`;

/** The files that pin the images, as the repository has them. */
function pinFiles({ postgres = PIN, node = NODE, semgrep = SEMGREP } = {}) {
  return {
    "docker-compose.prod.yml": `services:\n  db:\n    image: ${postgres}\n`,
    Dockerfile: `FROM ${node} AS base\nFROM base AS build\n`,
    "docker/semgrep/Dockerfile": `# Scanned with.\nFROM ${semgrep}\n`,
  };
}

test("the images are read from the files that pin them", () => {
  const files = pinFiles();
  assert.deepEqual(Object.keys(files), PIN_FILES);
  assert.deepEqual(
    ciImages(MIRROR, (path) => files[path]),
    [
      { name: "postgres", upstream: PIN, pull: `${MIRROR}/${PIN}` },
      {
        name: "node",
        upstream: NODE,
        pull: `${MIRROR}/node:26-slim@${DIGEST}`,
      },
      {
        name: "semgrep",
        upstream: SEMGREP,
        pull: `${MIRROR}/semgrep:1.2.3@${DIGEST}`,
      },
    ],
  );
});

test("a pin that moved or changed image is reported, not skipped", () => {
  const files = pinFiles();
  assert.throws(
    () =>
      ciImages(MIRROR, (path) =>
        path === "docker-compose.prod.yml" ? "services: {}\n" : files[path],
      ),
    /docker-compose\.prod\.yml pins no postgres image/,
  );
  for (const [changed, expected] of [
    [{ node: `python:3-slim@${DIGEST}` }, /expects an image of library\/node/],
    [
      { node: `someone/node:26@${DIGEST}` },
      /expects an image of library\/node/,
    ],
    [
      { semgrep: `someone/semgrep:1@${DIGEST}` },
      /expects an image of semgrep\/semgrep/,
    ],
    [
      { semgrep: `ghcr.io/someone/semgrep:1@${DIGEST}` },
      /not a Docker Hub image/,
    ],
  ]) {
    const other = pinFiles(changed);
    assert.throws(() => ciImages(MIRROR, (path) => other[path]), expected);
  }
});

test("waiting can be for some of the images", () => {
  const files = pinFiles();
  const images = ciImages(MIRROR, (path) => files[path]);
  assert.deepEqual(
    selectImages(images, ["node", "postgres"]).map(({ name }) => name),
    ["node", "postgres"],
  );
  assert.equal(selectImages(images, []), images);
  assert.throws(() => selectImages(images, ["mailpit"]), /no image called/);
});

const IMAGES = [{ name: "postgres", upstream: PIN, pull: `${MIRROR}/${PIN}` }];

/** The tag of the digest the pin names, which no other digest is given. */
const DIGEST_TAG = `pin-sha256-${DIGEST.slice("sha256:".length)}`;

test("a digest's tag is tied to it, and is no tag the OCI spec reserves", () => {
  assert.equal(digestTag(DIGEST), DIGEST_TAG);
  assert.notEqual(digestTag(DIGEST), digestTag(OTHER_DIGEST));
  assert.match(DIGEST_TAG, /^\w[\w.-]{0,127}$/);
  // The referrers tag schema gives sha256-<hex> to an index of referrers.
  assert.doesNotMatch(DIGEST_TAG, /^sha256-/);
});

test("an image the mirror serves under its digest's tag is neither copied nor tagged again", () => {
  const { runner, calls } = registry({
    serving: new Set([`${MIRROR}/postgres`]),
    tagged: new Set([`${MIRROR}/postgres:${DIGEST_TAG}`]),
  });
  assert.deepEqual(mirrorImages(IMAGES, MIRROR, { runner, log: () => {} }), []);
  assert.equal(calls.filter((call) => call.includes(" copy ")).length, 0);
});

test("an image the mirror serves under another tag is given its digest's tag where it is", () => {
  // A copy made before digestTag, under the pin's tag, or one a pull
  // request's tag alone holds, which the branch's pin adopts.
  const { runner, calls } = registry({
    serving: new Set([`${MIRROR}/postgres`]),
    tagged: new Set([`${MIRROR}/postgres:pr-11`]),
  });
  const slept = [];
  assert.deepEqual(
    mirrorImages(IMAGES, MIRROR, {
      runner,
      sleep: (ms) => slept.push(ms),
      log: () => {},
    }),
    [],
  );
  assert.deepEqual(
    calls.filter((call) => call.includes(" copy ")),
    [
      `skopeo copy --all --preserve-digests docker://${MIRROR}/postgres@${DIGEST} docker://${MIRROR}/postgres:${DIGEST_TAG}`,
    ],
  );
  // A prune may be deleting it, so the tag is checked after the wait.
  assert.deepEqual(slept, [SETTLE_MS]);
});

test("with a tag, an image the mirror serves is given it where it is", () => {
  const { runner, calls } = registry({
    serving: new Set([`${MIRROR}/postgres`]),
  });
  const slept = [];
  assert.deepEqual(
    mirrorImages(IMAGES, MIRROR, {
      tag: "pr-7",
      runner,
      sleep: (ms) => slept.push(ms),
      log: () => {},
    }),
    [],
  );
  assert.deepEqual(
    calls.filter((call) => call.includes(" copy ")),
    [
      `skopeo copy --all --preserve-digests docker://${MIRROR}/postgres@${DIGEST} docker://${MIRROR}/postgres:pr-7`,
    ],
  );
  // Then it waits, and checks the copy is still there.
  assert.deepEqual(slept, [SETTLE_MS]);
  assert.match(calls.at(-1), /^skopeo inspect /);
});

test("with a tag that names the copy already, nothing is tagged again", () => {
  const { runner, calls } = registry({
    serving: new Set([`${MIRROR}/postgres`]),
    tagged: new Set([`${MIRROR}/postgres:pr-7`]),
  });
  const slept = [];
  assert.deepEqual(
    mirrorImages(IMAGES, MIRROR, {
      tag: "pr-7",
      runner,
      sleep: (ms) => slept.push(ms),
      log: () => {},
    }),
    [],
  );
  assert.equal(calls.filter((call) => call.includes(" copy ")).length, 0);
  assert.deepEqual(slept, []);
});

test("a copy a prune deleted as it was tagged is copied again", () => {
  const serving = new Set([`${MIRROR}/postgres`]);
  const { runner, calls } = registry({ serving });
  const slept = [];
  assert.deepEqual(
    mirrorImages(IMAGES, MIRROR, {
      tag: "pr-7",
      runner,
      sleep: (ms) => {
        if (slept.push(ms) === 1) {
          serving.delete(`${MIRROR}/postgres`);
        }
      },
      log: () => {},
    }),
    [],
  );
  assert.equal(
    calls.filter((call) => call.includes(" copy ")).at(-1),
    `skopeo copy --all --preserve-digests --retry-times 3 docker://docker.io/library/postgres@${DIGEST} docker://${MIRROR}/postgres:pr-7`,
  );
  assert.ok(serving.has(`${MIRROR}/postgres`));
  // The new copy is checked again, as a prune could be deleting it too.
  assert.deepEqual(slept, [SETTLE_MS, SETTLE_MS]);
});

/**
 * A skopeo for keepTagged: the mirror serves MANIFEST by its digest, and
 * `tags` says which digest each tag names, if any; tagging sets the tag to
 * the digest, unless `untag` takes it off again.
 */
function tagRegistry(tags, { untag = () => false } = {}) {
  const calls = [];
  const runner = (program, args) => {
    calls.push([program, ...args].join(" "));
    const reference = args.at(-1).slice("docker://".length);
    if (args[0] === "inspect") {
      const named = reference.includes("@")
        ? DIGEST
        : tags.get(reference.split(":").at(-1));
      return named === DIGEST
        ? ok(MANIFEST)
        : named === undefined
          ? failed("manifest unknown")
          : ok(OTHER_MANIFEST);
    }
    const tag = reference.split(":").at(-1);
    tags.set(tag, DIGEST);
    if (untag(tag)) {
      tags.delete(tag);
    }
    return ok();
  };
  return { runner, calls };
}

const TAGGED = [{ image: IMAGES[0], tag: "pr-7" }];

test("a tag deleted with its copy is put back where another run made the copy again", () => {
  const tags = new Map();
  const { runner, calls } = tagRegistry(tags);
  assert.deepEqual(
    keepTagged(TAGGED, MIRROR, { runner, sleep: () => {}, log: () => {} }),
    [],
  );
  assert.deepEqual(
    calls.filter((call) => call.includes(" copy ")),
    [
      `skopeo copy --all --preserve-digests docker://${MIRROR}/postgres@${DIGEST} docker://${MIRROR}/postgres:pr-7`,
    ],
  );
  assert.equal(tags.get("pr-7"), DIGEST);
});

test("a tag a later run moved to another digest is left there", () => {
  const tags = new Map([["pr-7", OTHER_DIGEST]]);
  const { runner, calls } = tagRegistry(tags);
  const lines = [];
  assert.deepEqual(
    keepTagged(TAGGED, MIRROR, {
      runner,
      sleep: () => {},
      log: (line) => lines.push(line),
    }),
    [],
  );
  assert.equal(calls.filter((call) => call.includes(" copy ")).length, 0);
  assert.equal(tags.get("pr-7"), OTHER_DIGEST);
  assert.match(lines.join("\n"), /pr-7 names sha256:.* now, not sha256:/);
});

test("a tag deleted each time it is put back is a failure in the end", () => {
  const tags = new Map();
  const { runner, calls } = tagRegistry(tags, { untag: () => true });
  const slept = [];
  const [failure, ...rest] = keepTagged(TAGGED, MIRROR, {
    runner,
    sleep: (ms) => slept.push(ms),
    log: () => {},
  });
  assert.deepEqual(rest, []);
  assert.match(
    failure,
    /postgres:pr-7 was deleted with .* each of the 4 times/,
  );
  assert.equal(calls.filter((call) => call.includes(" copy ")).length, 3);
  assert.equal(slept.length, 4);
});

test("a copy that could not be tagged where it is is copied from the sources", () => {
  const { runner, calls } = registry({
    serving: new Set([`${MIRROR}/postgres`]),
    refusing: new Set([`${MIRROR}/postgres`]),
  });
  const slept = [];
  assert.deepEqual(
    mirrorImages(IMAGES, MIRROR, {
      tag: "pr-7",
      runner,
      sleep: (ms) => slept.push(ms),
      log: () => {},
    }),
    [],
  );
  assert.match(
    calls.filter((call) => call.includes(" copy ")).at(-1),
    /docker:\/\/docker\.io\/library\/postgres@.* docker:\/\/ghcr\.io\/openbrf\/ci-mirror\/postgres:pr-7$/,
  );
  assert.deepEqual(slept, []);
});

test("the wait after tagging is a minute unless set otherwise", () => {
  assert.equal(settleMsOf({}), 60_000);
  assert.equal(settleMsOf({ OPENBRF_MIRROR_SETTLE_SECONDS: "0" }), 0);
  assert.throws(
    () => settleMsOf({ OPENBRF_MIRROR_SETTLE_SECONDS: "1m" }),
    /not a number of seconds/,
  );
});

test("a copy keeps every platform and the digest, tagged with the digest's tag", () => {
  const { runner, calls } = registry();
  assert.deepEqual(mirrorImages(IMAGES, MIRROR, { runner, log: () => {} }), []);
  assert.deepEqual(
    calls.filter((call) => call.includes(" copy ")),
    [
      `skopeo copy --all --preserve-digests --retry-times 3 docker://docker.io/library/postgres@${DIGEST} docker://${MIRROR}/postgres:${DIGEST_TAG}`,
    ],
  );
});

test("a copy can be pushed under a tag of the caller's", () => {
  const { runner, calls } = registry();
  assert.deepEqual(
    mirrorImages(IMAGES, MIRROR, { tag: "pr-7", runner, log: () => {} }),
    [],
  );
  assert.match(
    calls.find((call) => call.includes(" copy ")),
    / docker:\/\/ghcr\.io\/openbrf\/ci-mirror\/postgres:pr-7$/,
  );
  for (const tag of ["", "-x", "a b", "a:b", "t".repeat(129)]) {
    assert.throws(
      () => mirrorImages(IMAGES, MIRROR, { tag, runner, log: () => {} }),
      /not a tag/,
    );
  }
});

test("a source that refuses is passed over for the next", () => {
  const { runner, calls } = registry({
    refusing: new Set(["docker.io/library/postgres"]),
  });
  assert.deepEqual(mirrorImages(IMAGES, MIRROR, { runner, log: () => {} }), []);
  assert.match(
    calls.filter((call) => call.includes(" copy ")).at(-1),
    /public\.ecr\.aws\/docker\/library\/postgres@/,
  );
});

test("a copy whose manifest does not hash to the digest is not accepted", () => {
  const runner = (_program, args) =>
    args[0] === "inspect" ? ok(Buffer.from("{}")) : ok();
  const [failure] = mirrorImages(IMAGES, MIRROR, { runner, log: () => {} });
  assert.match(failure, /hashes to sha256:/);
});

test("an image no source hands over is a failure naming every source", () => {
  const { runner } = registry({
    refusing: new Set([
      "docker.io/library/postgres",
      "public.ecr.aws/docker/library/postgres",
      "mirror.gcr.io/library/postgres",
    ]),
  });
  const [failure] = mirrorImages(IMAGES, MIRROR, { runner, log: () => {} });
  assert.match(failure, /could not be copied/);
  assert.match(failure, /from docker\.io/);
  assert.match(failure, /from public\.ecr\.aws/);
  assert.match(failure, /from mirror\.gcr\.io/);
});

test("waiting ends as soon as the mirror serves every image", () => {
  const serving = new Set();
  let clock = 0;
  const { runner } = registry({ serving });
  const missing = waitForMirror(IMAGES, MIRROR, {
    runner,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      serving.add(`${MIRROR}/postgres`);
    },
    log: () => {},
  });
  assert.deepEqual(missing, []);
  assert.equal(clock, 20_000);
});

test("an image still missing at the deadline is reported", () => {
  let clock = 0;
  const { runner } = registry();
  const missing = waitForMirror(IMAGES, MIRROR, {
    runner,
    timeoutMs: 60_000,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
    },
    log: () => {},
  });
  assert.deepEqual(missing, [`${MIRROR}/${PIN}: manifest unknown`]);
  assert.equal(clock, 60_000);
});

/**
 * The script as .github/workflows/ci-images-pr.yml runs it for a pull request
 * from a fork: the pins read from a directory of the pull request's files,
 * with a skopeo on PATH that serves what `served` lists and records each call.
 */
const script = join(dirname(fileURLToPath(import.meta.url)), "ci-images.mjs");

function runCli(args, { files, served }) {
  const directory = mkdtempSync(join(tmpdir(), "ci-images-"));
  try {
    const pins = join(directory, "pins");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(pins, path)), { recursive: true });
      writeFileSync(join(pins, path), text);
    }
    const manifests = join(directory, "manifests");
    mkdirSync(manifests);
    writeFileSync(join(manifests, DIGEST), MANIFEST);
    writeFileSync(join(manifests, OTHER_DIGEST), OTHER_MANIFEST);
    writeFileSync(
      join(directory, "served"),
      served.map((ref) => `${ref}\n`).join(""),
    );
    writeFileSync(join(directory, "calls"), "");
    writeFileSync(
      join(directory, "skopeo"),
      `#!/usr/bin/env bash
echo "$*" >> "$SKOPEO_DIR/calls"
case "$1" in
  inspect)
    ref="\${3#docker://}"
    case "$ref" in
      *@*) grep -qxF "$ref" "$SKOPEO_DIR/served" && digest="\${ref##*@}" ;;
      # By tag: the digest the last copy under it named.
      *) digest="$(grep -F "$ref@" "$SKOPEO_DIR/served" | tail -n 1)"
         digest="\${digest##*@}" ;;
    esac
    if [ -n "\${digest:-}" ]; then
      cat "$SKOPEO_DIR/manifests/$digest"
      exit 0
    fi
    echo "manifest unknown" >&2
    exit 1 ;;
  copy)
    source="\${*: -2:1}"
    target="\${*: -1}"
    target="\${target#docker://}"
    echo "\${target%:*}@\${source##*@}" >> "$SKOPEO_DIR/served"
    echo "$target@\${source##*@}" >> "$SKOPEO_DIR/served"
    exit 0 ;;
esac
exit 2
`,
    );
    chmodSync(join(directory, "skopeo"), 0o755);
    const result = spawnSync(
      process.execPath,
      [script, ...args.map((arg) => (arg === "PINS" ? pins : arg))],
      {
        encoding: "utf8",
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          SKOPEO_DIR: directory,
          OPENBRF_IMAGE_MIRROR: MIRROR,
          OPENBRF_MIRROR_SETTLE_SECONDS: "0",
        },
      },
    );
    return {
      status: result.status,
      stderr: result.stderr,
      calls: readFileSync(join(directory, "calls"), "utf8")
        .split("\n")
        .filter(Boolean),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** What the mirror serves for the pins on the base branch. */
const MAIN_SERVED = [
  `${MIRROR}/postgres@${DIGEST}`,
  `${MIRROR}/node@${DIGEST}`,
  `${MIRROR}/semgrep@${DIGEST}`,
];

test("a fork's pull request that changes a pin has that pin copied, under the pull request's tag", () => {
  const proposed = `postgres:18.1-alpine@${OTHER_DIGEST}`;
  const result = runCli(["mirror", "--pins-from", "PINS", "--tag", "pr-42"], {
    files: pinFiles({ postgres: proposed }),
    served: MAIN_SERVED,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.calls.filter((call) => call.startsWith("copy ")),
    [
      `copy --all --preserve-digests --retry-times 3 docker://docker.io/library/postgres@${OTHER_DIGEST} docker://${MIRROR}/postgres:pr-42`,
      `copy --all --preserve-digests docker://${MIRROR}/node@${DIGEST} docker://${MIRROR}/node:pr-42`,
      `copy --all --preserve-digests docker://${MIRROR}/semgrep@${DIGEST} docker://${MIRROR}/semgrep:pr-42`,
    ],
  );
  // The fork's CI then finds the copy, as it waits for it by the digest.
  const wait = runCli(["wait", "--pins-from", "PINS", "postgres"], {
    files: pinFiles({ postgres: proposed }),
    served: [...MAIN_SERVED, `${MIRROR}/postgres@${OTHER_DIGEST}`],
  });
  assert.equal(wait.status, 0, wait.stderr);
  assert.match(
    wait.stderr,
    new RegExp(`serves ${MIRROR}/postgres:18\\.1-alpine@`),
  );
});

test("a fork's pull request that changes no pin only tags the copies there are, and its CI finds every image", () => {
  const mirror = runCli(["mirror", "--pins-from", "PINS", "--tag", "pr-42"], {
    files: pinFiles(),
    served: MAIN_SERVED,
  });
  assert.equal(mirror.status, 0, mirror.stderr);
  assert.deepEqual(
    mirror.calls.filter((call) => !call.startsWith("inspect ")),
    ["postgres", "node", "semgrep"].map(
      (name) =>
        `copy --all --preserve-digests docker://${MIRROR}/${name}@${DIGEST} docker://${MIRROR}/${name}:pr-42`,
    ),
  );
  const wait = runCli(["wait", "--pins-from", "PINS"], {
    files: pinFiles(),
    served: MAIN_SERVED,
  });
  assert.equal(wait.status, 0, wait.stderr);
  assert.deepEqual(
    wait.calls.filter((call) => !call.startsWith("inspect ")),
    [],
  );
});

test("a fork's pull request that pins an image from elsewhere has nothing copied", () => {
  for (const files of [
    pinFiles({ node: `ghcr.io/someone/node:26@${OTHER_DIGEST}` }),
    pinFiles({ semgrep: `someone/semgrep:1@${OTHER_DIGEST}` }),
    pinFiles({ postgres: "postgres:18-alpine" }),
  ]) {
    const result = runCli(["mirror", "--pins-from", "PINS", "--tag", "pr-42"], {
      files,
      served: MAIN_SERVED,
    });
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
  }
});
