/**
 * The third-party images CI runs, and the copies of them it pulls instead.
 *
 * Docker Hub and Amazon's ECR Public both meter anonymous pulls per address,
 * and GitHub's runners share their addresses with everyone else's CI, so a
 * quota spent by somebody else failed our runs whatever the code did. A login
 * to either would need a secret, which a pull request from a fork, or from
 * Dependabot, is not given. What every run does have is its GITHUB_TOKEN, and
 * pulls from the GitHub Container Registry made with it are not metered. So CI
 * pulls these images from copies in the registry named by OPENBRF_IMAGE_MIRROR
 * (ghcr.io/openbrf/ci-mirror), which .github/workflows/ci-images.yml makes.
 *
 * The pins stay where they were, and where Dependabot keeps them current:
 * PostgreSQL in docker-compose.prod.yml and Node.js on the Dockerfile's first
 * FROM line. A copy keeps the tag and the digest and changes only the
 * registry, and every pull names the digest, so the image CI tests is the one
 * an operator runs, byte for byte. Nothing in the repository names a copy:
 * each is derived from its pin here, so a pin that moves takes CI with it and
 * there is no second reference to bump by hand.
 *
 *   node scripts/ci-images.mjs refs     what to pull, by image, as JSON
 *   node scripts/ci-images.mjs wait     until the mirror serves every image
 *   node scripts/ci-images.mjs mirror   copies the images the mirror lacks
 *
 * Without OPENBRF_IMAGE_MIRROR, `refs` names the pins themselves, which is
 * what a run on a developer's machine pulls.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fromImagesOf, pinsOf } from "./check-image-pins.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The images CI would otherwise pull from a metered registry, and the file
 * that pins each. mailpit is not here: it is published to the GitHub Container
 * Registry already, and the login that reaches the mirror reaches it too.
 */
const PINNED = [
  {
    name: "postgres",
    file: "docker-compose.prod.yml",
    read: (source) => pinsOf(source, "postgres")[0],
  },
  {
    name: "node",
    file: "Dockerfile",
    read: (source) => fromImagesOf(source)[0],
  },
];

/**
 * A Docker official image pinned by tag and digest, on Docker Hub or on one of
 * the registries that serve the official images under the same digests.
 */
const OFFICIAL_IMAGE =
  /^(?:(?:docker\.io|index\.docker\.io|registry-1\.docker\.io|mirror\.gcr\.io)\/library\/|library\/|public\.ecr\.aws\/docker\/library\/)?([a-z0-9]+(?:[._-][a-z0-9]+)*):(\w[\w.-]{0,127})@(sha256:[0-9a-f]{64})$/;

/** A registry and repository path, without a tag: `ghcr.io/openbrf/ci-mirror`. */
const MIRROR =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

/**
 * The name, tag and digest of an official image reference.
 *
 * @param {string} reference
 * @returns {{ name: string, tag: string, digest: string }}
 */
export function officialImage(reference) {
  const match = OFFICIAL_IMAGE.exec(reference);
  if (match === null) {
    throw new Error(
      `${reference} is not a Docker official image pinned by tag and digest ` +
        "(name:tag@sha256:...), so it has no copy in the CI image mirror.",
    );
  }
  const [, name, tag, digest] = match;
  return { name, tag, digest };
}

/**
 * The reference to pull for a pinned official image: its copy in `mirror`, or
 * the pin itself when there is no mirror.
 *
 * @param {string} reference
 * @param {string | undefined} mirror
 * @returns {string}
 */
export function pullRefOf(reference, mirror) {
  if (mirror === undefined || mirror === "") {
    return reference;
  }
  if (!MIRROR.test(mirror)) {
    throw new Error(
      `OPENBRF_IMAGE_MIRROR is ${mirror}, which is not a registry and ` +
        "repository path such as ghcr.io/openbrf/ci-mirror.",
    );
  }
  const { name, tag, digest } = officialImage(reference);
  return `${mirror}/${name}:${tag}@${digest}`;
}

/**
 * Where a copy is made from, in order. The same digest is served by all three,
 * and each meters anonymous pulls its own way, so a copy that one of them
 * throttles is taken from the next. Whichever answers, the copy is checked
 * against the digest.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function sourcesOf(name) {
  return [
    `docker.io/library/${name}`,
    `public.ecr.aws/docker/library/${name}`,
    `mirror.gcr.io/library/${name}`,
  ];
}

/**
 * Each image as pinned, and what to pull for it.
 *
 * @param {string | undefined} mirror
 * @param {(path: string) => string} readFile Relative to the repository root.
 * @returns {{ name: string, upstream: string, pull: string }[]}
 */
export function ciImages(mirror, readFile = readRepoFile) {
  return PINNED.map(({ name, file, read }) => {
    const upstream = read(readFile(file));
    if (upstream === undefined) {
      throw new Error(
        `${file} pins no ${name} image. If the pin moved, update PINNED in ` +
          "scripts/ci-images.mjs with it.",
      );
    }
    if (officialImage(upstream).name !== name) {
      throw new Error(
        `${file} pins ${upstream} where scripts/ci-images.mjs expects the ` +
          `${name} official image.`,
      );
    }
    return { name, upstream, pull: pullRefOf(upstream, mirror) };
  });
}

/**
 * @typedef {(program: string, args: string[]) => { status: number | null, stdout: Buffer, stderr: string }} Run
 */

/** Runs a program to completion, its output captured. */
function run(program, args) {
  const result = spawnSync(program, args, { maxBuffer: 64 * 1024 * 1024 });
  return {
    status: result.error === undefined ? result.status : null,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: String(result.error ?? result.stderr ?? ""),
  };
}

/**
 * Whether `repository` serves `digest`, read with skopeo, whose own digest
 * check this repeats: the manifest it returns has to hash to the digest asked
 * for.
 *
 * @param {Run} runner
 * @param {string} repository
 * @param {string} digest
 * @returns {{ present: boolean, detail: string }}
 */
function served(runner, repository, digest) {
  const result = runner("skopeo", [
    "inspect",
    "--raw",
    `docker://${repository}@${digest}`,
  ]);
  if (result.status !== 0) {
    return { present: false, detail: result.stderr.trim() };
  }
  const actual = `sha256:${createHash("sha256").update(result.stdout).digest("hex")}`;
  return actual === digest
    ? { present: true, detail: "" }
    : {
        present: false,
        detail: `the manifest served for ${digest} hashes to ${actual}`,
      };
}

/**
 * Copies every image the mirror does not serve yet, from the first source
 * that hands it over, all platforms and the index as they are, so that the
 * copy keeps its digest. Returns what could not be copied, one line each.
 *
 * Each copy is pushed under the pin's tag, which a registry needs to push to.
 * CI never pulls by that tag, only by the digest: a later copy under the same
 * tag takes it over, and the earlier copy stays, untagged, for the commits
 * that still pin it. Deleting untagged versions of these packages breaks
 * re-runs of those commits until the daily run copies the pin on main again.
 *
 * @param {{ name: string, upstream: string, pull: string }[]} images
 * @param {string} mirror
 * @param {{ runner?: Run, log?: (line: string) => void }} [options]
 * @returns {string[]}
 */
export function mirrorImages(
  images,
  mirror,
  { runner = run, log = console.error } = {},
) {
  const failures = [];
  for (const { name, upstream } of images) {
    const { tag, digest } = officialImage(upstream);
    const repository = `${mirror}/${name}`;
    if (served(runner, repository, digest).present) {
      log(`${repository}@${digest} is mirrored already.`);
      continue;
    }
    const attempts = [];
    let copied = false;
    for (const source of sourcesOf(name)) {
      const copy = runner("skopeo", [
        "copy",
        "--all",
        "--preserve-digests",
        "--retry-times",
        "3",
        `docker://${source}@${digest}`,
        `docker://${repository}:${tag}`,
      ]);
      if (copy.status !== 0) {
        attempts.push(`  from ${source}: ${copy.stderr.trim()}`);
        continue;
      }
      const check = served(runner, repository, digest);
      if (check.present) {
        log(`Copied ${source}@${digest} to ${repository}:${tag}.`);
        copied = true;
        break;
      }
      attempts.push(`  from ${source}: ${check.detail}`);
    }
    if (!copied) {
      failures.push(
        `${upstream} could not be copied to ${repository}:\n${attempts.join("\n")}`,
      );
    }
  }
  return failures;
}

/**
 * Waits until the mirror serves every image, and returns the ones it still
 * does not serve when `timeoutMs` has passed.
 *
 * A pin changed by a push to this repository is copied by the mirror workflow
 * that push starts, at the same time as CI starts, so a run may ask for a copy
 * a minute or two before it exists. A pin changed in a fork is copied only
 * once its commit reaches a branch here, which is what the failure says.
 *
 * @param {{ name: string, upstream: string, pull: string }[]} images
 * @param {string} mirror
 * @param {{ runner?: Run, timeoutMs?: number, intervalMs?: number, now?: () => number, sleep?: (ms: number) => void, log?: (line: string) => void }} [options]
 * @returns {string[]}
 */
export function waitForMirror(
  images,
  mirror,
  {
    runner = run,
    timeoutMs = 10 * 60_000,
    intervalMs = 20_000,
    now = Date.now,
    sleep = blockFor,
    log = console.error,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let waiting = images;
  for (;;) {
    const missing = waiting
      .map((image) => ({
        image,
        ...served(
          runner,
          `${mirror}/${image.name}`,
          officialImage(image.upstream).digest,
        ),
      }))
      .filter(({ present }) => !present);
    if (missing.length === 0 || now() >= deadline) {
      return missing.map(({ image, detail }) => `${image.pull}: ${detail}`);
    }
    waiting = missing.map(({ image }) => image);
    log(
      `Waiting for the CI image mirror to serve ${waiting.map(({ pull }) => pull).join(", ")}.`,
    );
    sleep(intervalMs);
  }
}

/** Blocks the thread; nothing else runs in this process. */
function blockFor(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * A file of the repository.
 *
 * @param {string} path
 * @returns {string}
 */
function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

if (import.meta.main) {
  const command = process.argv[2];
  const mirror = process.env.OPENBRF_IMAGE_MIRROR;
  try {
    const images = ciImages(mirror);
    if (command === "refs") {
      process.stdout.write(
        `${JSON.stringify(Object.fromEntries(images.map(({ name, upstream, pull }) => [name, { upstream, pull }])))}\n`,
      );
    } else if (command === "wait" || command === "mirror") {
      if (mirror === undefined || mirror === "") {
        throw new Error(
          `OPENBRF_IMAGE_MIRROR is not set, so there is no mirror to ${command} for.`,
        );
      }
      const failures =
        command === "wait"
          ? waitForMirror(images, mirror)
          : mirrorImages(images, mirror);
      if (failures.length > 0) {
        throw new Error(
          command === "wait"
            ? "The CI image mirror does not serve these images:\n" +
                `${failures.join("\n")}\n\n` +
                "The Mirror CI images workflow copies a pin when a push to a " +
                "branch of this repository changes it, and every day. A pull " +
                "request from a fork that changes a pin needs its commit pushed " +
                "to a branch here once, by a maintainer, before CI can pass."
            : failures.join("\n\n"),
        );
      }
      process.stderr.write(
        command === "wait"
          ? `The CI image mirror serves ${images.map(({ pull }) => pull).join(", ")}.\n`
          : "Every CI image is mirrored.\n",
      );
    } else {
      throw new Error("Usage: node scripts/ci-images.mjs refs | wait | mirror");
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
