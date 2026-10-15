/**
 * How scripts/dockerfile-guards.test.mjs gets its base image when a registry
 * throttles or fails the pull: from the mirror, after a retry, from the
 * Dockerfile's own registry, or not at all.
 *
 * The real pullBaseImage and the real dockerfile-guards.test.mjs run against a
 * `docker` stub that records its arguments and answers each pull from a script
 * the test wrote, so no registry is involved. Run with `node --test` from
 * `pnpm lint:guards`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { fromImagesOf } from "./check-image-pins.mjs";
import {
  MIRROR,
  PULL_ATTEMPTS,
  pullBaseImage,
  pullCandidates,
} from "./pull-base-image.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const IMAGE = fromImagesOf(
  readFileSync(join(scripts, "..", "Dockerfile"), "utf8"),
)[0];
const MIRROR_IMAGE = IMAGE.replace(/^public\.ecr\.aws\/docker\//, `${MIRROR}/`);
const THROTTLED =
  "toomanyrequests: Data limit exceeded, rate limit exceeded for this address";

let directory;
let log;
let outcomes;

/**
 * Logs every call as one line, `<subcommand> <arguments>`. A pull consumes the
 * next line of `outcomes/<reference with / as _>`, an exit status and a
 * message separated by a space, and exits 0 once the lines are used up. `info`
 * and `run` succeed.
 */
before(() => {
  directory = mkdtempSync(join(tmpdir(), "pull-base-image-"));
  outcomes = join(directory, "outcomes");
  log = join(directory, "docker.log");
  writeFileSync(
    join(directory, "docker"),
    `#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
[[ "$1" == pull ]] || exit 0
file="$DOCKER_OUTCOMES/\${3//\\//_}"
if [[ -s "$file" ]]; then
  read -r status message < "$file"
  tail -n +2 "$file" > "$file.next" && mv "$file.next" "$file"
  echo "$message" >&2
  exit "$status"
fi
exit 0
`,
  );
  chmodSync(join(directory, "docker"), 0o755);
});

after(() => rmSync(directory, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(outcomes, { recursive: true, force: true });
  spawnSync("mkdir", ["-p", outcomes]);
  writeFileSync(log, "");
});

/** Scripts what pulling `reference` answers, one exit status and message per call. */
function script(reference, ...answers) {
  writeFileSync(
    join(outcomes, reference.replaceAll("/", "_")),
    answers.map(([status, message]) => `${status} ${message}\n`).join(""),
  );
}

const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
const pulls = () =>
  calls()
    .filter((call) => call.startsWith("pull "))
    .map((call) => call.slice(5));

/** Runs `fn` with the stub first on PATH. */
function withStub(fn) {
  const saved = { ...process.env };
  process.env.PATH = `${directory}:${process.env.PATH}`;
  process.env.DOCKER_LOG = log;
  process.env.DOCKER_OUTCOMES = outcomes;
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

/** pullBaseImage with no waiting, and the pauses it asked for. */
function pull(image = IMAGE) {
  const pauses = [];
  const reference = withStub(() =>
    pullBaseImage(image, { pause: (ms) => pauses.push(ms) }),
  );
  return { reference, pauses };
}

const failures = (n, message = THROTTLED) =>
  Array.from({ length: n }, () => [1, message]);

test("the mirror is tried first, with the Dockerfile's tag and digest", () => {
  assert.match(
    IMAGE,
    /^public\.ecr\.aws\/docker\/library\/.+:.+@sha256:[0-9a-f]{64}$/,
  );
  assert.deepEqual(pullCandidates(IMAGE), [MIRROR_IMAGE, IMAGE]);
  assert.ok(MIRROR_IMAGE.startsWith(`${MIRROR}/library/`));
  assert.equal(
    MIRROR_IMAGE.slice(MIRROR_IMAGE.indexOf(":")),
    IMAGE.slice(IMAGE.indexOf(":")),
  );
});

test("an image that is not an ECR Public official image is pulled as named", () => {
  for (const image of [
    `registry.example/library/node:1@sha256:${"a".repeat(64)}`,
    `public.ecr.aws/other/node:1@sha256:${"a".repeat(64)}`,
    `docker.io/library/node:1@sha256:${"a".repeat(64)}`,
  ]) {
    assert.deepEqual(pullCandidates(image), [image]);
  }
});

test("a mirror that has the image is used, and the registry is not asked", () => {
  const { reference, pauses } = pull();
  assert.equal(reference, MIRROR_IMAGE);
  assert.deepEqual(pulls(), [`--quiet ${MIRROR_IMAGE}`]);
  assert.deepEqual(pauses, []);
});

test("a throttled mirror is retried, with a growing pause, and used once it answers", () => {
  script(MIRROR_IMAGE, ...failures(PULL_ATTEMPTS - 1));
  const { reference, pauses } = pull();
  assert.equal(reference, MIRROR_IMAGE);
  assert.deepEqual(
    pulls(),
    Array(PULL_ATTEMPTS).fill(`--quiet ${MIRROR_IMAGE}`),
  );
  assert.equal(pauses.length, PULL_ATTEMPTS - 1);
  assert.ok(pauses.every((ms, i) => ms > 0 && (i === 0 || ms > pauses[i - 1])));
});

test("a mirror that fails every attempt falls back to the Dockerfile's registry", () => {
  script(MIRROR_IMAGE, ...failures(PULL_ATTEMPTS));
  const { reference } = pull();
  assert.equal(reference, IMAGE);
  assert.deepEqual(pulls(), [
    ...Array(PULL_ATTEMPTS).fill(`--quiet ${MIRROR_IMAGE}`),
    `--quiet ${IMAGE}`,
  ]);
});

test("the Dockerfile's registry is retried too, and used once it answers", () => {
  script(MIRROR_IMAGE, ...failures(PULL_ATTEMPTS));
  script(IMAGE, ...failures(PULL_ATTEMPTS - 1));
  const { reference } = pull();
  assert.equal(reference, IMAGE);
  assert.equal(pulls().filter((p) => p.endsWith(IMAGE)).length, PULL_ATTEMPTS);
});

test("with both registries failing every attempt, the pull throws and says why", () => {
  script(MIRROR_IMAGE, ...failures(PULL_ATTEMPTS, "mirror said no"));
  script(IMAGE, ...failures(PULL_ATTEMPTS, THROTTLED));
  assert.throws(
    () => pull(),
    (error) => {
      assert.match(error.message, /^Could not pull the base image:/);
      assert.match(error.message, /mirror said no/);
      assert.match(error.message, /toomanyrequests/);
      for (const reference of [MIRROR_IMAGE, IMAGE]) {
        assert.ok(
          error.message.includes(`${reference}, attempt ${PULL_ATTEMPTS}`),
        );
      }
      return true;
    },
  );
  assert.equal(pulls().length, 2 * PULL_ATTEMPTS);
});

test("a base image without a mirror is retried and then fails the same way", () => {
  const image = `registry.example/library/node:1@sha256:${"a".repeat(64)}`;
  script(image, ...failures(PULL_ATTEMPTS));
  assert.throws(() => pull(image), /Could not pull the base image/);
  assert.deepEqual(pulls(), Array(PULL_ATTEMPTS).fill(`--quiet ${image}`));
});

test("the guard test pulls the base image once and runs every case from that copy", () => {
  // The whole of dockerfile-guards.test.mjs, with `docker run` answering 0 for
  // every case; only what it asked Docker to do is read.
  spawnSync(process.execPath, [join(scripts, "dockerfile-guards.test.mjs")], {
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      DOCKER_LOG: log,
      DOCKER_OUTCOMES: outcomes,
    },
    stdio: "ignore",
  });
  assert.deepEqual(pulls(), [`--quiet ${MIRROR_IMAGE}`]);
  const runs = calls().filter((call) => call.startsWith("run "));
  assert.ok(runs.length >= 24, `${runs.length} cases ran`);
  for (const call of runs) {
    const args = call.split(" ");
    assert.equal(args[args.indexOf("--pull") + 1], "never", call);
    assert.ok(call.includes(` ${MIRROR_IMAGE} `), call);
    assert.ok(!call.includes(IMAGE), call);
  }
});
