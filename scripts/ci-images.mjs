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
 * PostgreSQL in docker-compose.prod.yml, Node.js on the Dockerfile's first
 * FROM line and Semgrep in docker/semgrep/Dockerfile. A copy keeps the tag and
 * the digest and changes only the registry, and every pull names the digest,
 * so the image CI tests is the one an operator runs, byte for byte. Nothing in
 * the repository names a copy: each is derived from its pin here, so a pin
 * that moves takes CI with it and there is no second reference to bump by
 * hand.
 *
 *   node scripts/ci-images.mjs refs           what to pull, by image, as JSON
 *   node scripts/ci-images.mjs wait [name..]  until the mirror serves them
 *   node scripts/ci-images.mjs mirror         copies the images the mirror lacks
 *   node scripts/ci-images.mjs files          the files that pin them
 *
 * `wait` waits for every image unless given the names of some. `mirror` reads
 * the pins from the repository, or with `--pins-from <directory>` from copies
 * of the files `files` lists, and with `--tag <tag>` puts each copy under
 * that tag rather than its digest's (digestTag):
 * .github/workflows/ci-images-pr.yml uses both for a pull request from a fork.
 *
 * scripts/prune-ci-mirror.mjs clears out the copies pull requests leave behind.
 *
 * Without OPENBRF_IMAGE_MIRROR, `refs` names the pins themselves, which is
 * what a run on a developer's machine pulls.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { fromImagesOf, pinsOf } from "./check-image-pins.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The images CI would otherwise pull from a metered registry, the Docker Hub
 * repository each comes from, and the file that pins each. mailpit is not
 * here: it is published to the GitHub Container Registry already, and the
 * login that reaches the mirror reaches it too.
 */
const PINNED = [
  {
    name: "postgres",
    repository: "library/postgres",
    file: "docker-compose.prod.yml",
    read: (source) => pinsOf(source, "postgres")[0],
  },
  {
    name: "node",
    repository: "library/node",
    file: "Dockerfile",
    read: (source) => fromImagesOf(source)[0],
  },
  {
    name: "semgrep",
    repository: "semgrep/semgrep",
    file: "docker/semgrep/Dockerfile",
    read: (source) => fromImagesOf(source)[0],
  },
];

/**
 * A Docker Hub image pinned by tag and digest, on Docker Hub or on one of the
 * registries that serve its images under the same digests: Google's mirror of
 * Docker Hub, and for an official image Amazon's copy of those. The namespace
 * has no dot, which Docker would read as the name of another registry.
 */
const HUB_IMAGE =
  /^(?:(?:docker\.io|index\.docker\.io|registry-1\.docker\.io|mirror\.gcr\.io)\/|public\.ecr\.aws\/docker\/(?=library\/))?(?:((?!localhost\/)[a-z0-9]+(?:[_-][a-z0-9]+)*)\/)?([a-z0-9]+(?:[._-][a-z0-9]+)*):(\w[\w.-]{0,127})@(sha256:[0-9a-f]{64})$/;

/** A registry and repository path, without a tag: `ghcr.io/openbrf/ci-mirror`. */
const MIRROR =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

/** A tag, in Docker's grammar. */
const TAG = /^\w[\w.-]{0,127}$/;

/**
 * The Docker Hub repository, name, tag and digest of an image reference. The
 * name is the repository's last part, which is what the copy is called.
 *
 * @param {string} reference
 * @returns {{ repository: string, name: string, tag: string, digest: string }}
 */
export function hubImage(reference) {
  const match = HUB_IMAGE.exec(reference);
  if (match === null) {
    throw new Error(
      `${reference} is not a Docker Hub image pinned by tag and digest ` +
        "(name:tag@sha256:...), so it has no copy in the CI image mirror.",
    );
  }
  const [, namespace = "library", name, tag, digest] = match;
  return { repository: `${namespace}/${name}`, name, tag, digest };
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
  const { name, tag, digest } = hubImage(reference);
  return `${mirror}/${name}:${tag}@${digest}`;
}

/**
 * Where a copy is made from, in order. The same digest is served by each, and
 * each meters anonymous pulls its own way, so a copy that one of them
 * throttles is taken from the next. Whichever answers, the copy is checked
 * against the digest. Amazon's copy holds the official images only.
 *
 * @param {string} repository A Docker Hub repository: `library/postgres`.
 * @returns {string[]}
 */
export function sourcesOf(repository) {
  return [
    `docker.io/${repository}`,
    ...(repository.startsWith("library/")
      ? [`public.ecr.aws/docker/${repository}`]
      : []),
    `mirror.gcr.io/${repository}`,
  ];
}

/** The files that pin the images, relative to the repository root. */
export const PIN_FILES = PINNED.map(({ file }) => file);

/**
 * Each image as pinned, and what to pull for it.
 *
 * @param {string | undefined} mirror
 * @param {(path: string) => string} readFile Relative to the repository root.
 * @returns {{ name: string, upstream: string, pull: string }[]}
 */
export function ciImages(mirror, readFile = readRepoFile) {
  return PINNED.map(({ name, repository, file, read }) => {
    const upstream = read(readFile(file));
    if (upstream === undefined) {
      throw new Error(
        `${file} pins no ${name} image. If the pin moved, update PINNED in ` +
          "scripts/ci-images.mjs with it.",
      );
    }
    if (hubImage(upstream).repository !== repository) {
      throw new Error(
        `${file} pins ${upstream} where scripts/ci-images.mjs expects an ` +
          `image of ${repository}.`,
      );
    }
    return { name, upstream, pull: pullRefOf(upstream, mirror) };
  });
}

/**
 * The images named, in the order given; every image when none is.
 *
 * @param {{ name: string, upstream: string, pull: string }[]} images
 * @param {string[]} names
 * @returns {{ name: string, upstream: string, pull: string }[]}
 */
export function selectImages(images, names) {
  if (names.length === 0) {
    return images;
  }
  return names.map((wanted) => {
    const image = images.find(({ name }) => name === wanted);
    if (image === undefined) {
      throw new Error(
        `scripts/ci-images.mjs has no image called ${wanted}; it has ` +
          `${images.map(({ name }) => name).join(", ")}.`,
      );
    }
    return image;
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
 * The digest of the manifest a reference names, by digest or by tag, read
 * with skopeo; undefined, and why, when there is none to read.
 *
 * @param {Run} runner
 * @param {string} reference `ghcr.io/openbrf/ci-mirror/postgres:pr-7`
 * @returns {{ digest: string | undefined, detail: string }}
 */
function manifestDigest(runner, reference) {
  const result = runner("skopeo", [
    "inspect",
    "--raw",
    `docker://${reference}`,
  ]);
  if (result.status !== 0) {
    return { digest: undefined, detail: result.stderr.trim() };
  }
  return {
    digest: `sha256:${createHash("sha256").update(result.stdout).digest("hex")}`,
    detail: "",
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
  const { digest: actual, detail } = manifestDigest(
    runner,
    `${repository}@${digest}`,
  );
  if (actual === undefined) {
    return { present: false, detail };
  }
  return actual === digest
    ? { present: true, detail: "" }
    : {
        present: false,
        detail: `the manifest served for ${digest} hashes to ${actual}`,
      };
}

/**
 * How long a run that put a tag on a copy the mirror held already waits
 * before it checks that the copy is still there.
 *
 * scripts/prune-ci-mirror.mjs deletes a copy only while the tags it reads for
 * it, just before the deletion, are still the ones it planned on, and gives
 * up on a deletion when that reading takes more than a sixth of this. A prune
 * that read the tags a moment before this run added one can still delete the
 * copy, and the tag with it; this wait outlasts that moment, and the packages
 * API taking a while to show a new tag, so the check after it sees the tag
 * gone and puts it back.
 */
export const SETTLE_MS = 60_000;

/**
 * The tag a run for a branch puts on the copy of the digest its pin names.
 *
 * Only this digest ever has it, as no run pushes another under it, so the
 * copy keeps it for good. The pin's own tag, 18-alpine say, is no use for
 * that: a branch that pins another digest under the same tag would move it
 * there, and leave a copy that also holds the tag of a pull request with that
 * tag alone, which scripts/prune-ci-mirror.mjs deletes once the pull request
 * closes. `sha256-<hex>` alone is not used, as the OCI distribution spec
 * gives such a tag to the index of what refers to that digest.
 *
 * @param {string} digest `sha256:<hex>`
 * @returns {string} `pin-sha256-<hex>`
 */
export function digestTag(digest) {
  return `pin-${digest.replace(":", "-")}`;
}

/**
 * How many times keepTagged puts a tag back before it gives up on it.
 */
const RESTORES = 3;

/**
 * Puts `tag` on the copy of `digest` that `repository` serves, within the
 * registry. Returns why that failed, or undefined.
 *
 * @param {Run} runner
 * @param {string} repository
 * @param {string} digest
 * @param {string} tag
 * @returns {string | undefined}
 */
function tagCopy(runner, repository, digest, tag) {
  const copy = runner("skopeo", [
    "copy",
    "--all",
    "--preserve-digests",
    `docker://${repository}@${digest}`,
    `docker://${repository}:${tag}`,
  ]);
  return copy.status === 0 ? undefined : copy.stderr.trim() || "failed";
}

/**
 * Copies an image to the mirror under `tag` from the first source that hands
 * it over, all platforms and the index as they are, so that the copy keeps
 * its digest. Returns why it could not, or undefined.
 *
 * @param {{ name: string, upstream: string }} image
 * @param {string} mirror
 * @param {string} tag
 * @param {Run} runner
 * @param {(line: string) => void} log
 * @returns {string | undefined}
 */
function copyImage({ name, upstream }, mirror, tag, runner, log) {
  const { repository: hub, digest } = hubImage(upstream);
  const repository = `${mirror}/${name}`;
  const target = `${repository}:${tag}`;
  const attempts = [];
  for (const source of sourcesOf(hub)) {
    const copy = runner("skopeo", [
      "copy",
      "--all",
      "--preserve-digests",
      "--retry-times",
      "3",
      `docker://${source}@${digest}`,
      `docker://${target}`,
    ]);
    if (copy.status !== 0) {
      attempts.push(`  from ${source}: ${copy.stderr.trim()}`);
      continue;
    }
    const check = served(runner, repository, digest);
    if (check.present) {
      log(`Copied ${source}@${digest} to ${target}.`);
      return undefined;
    }
    attempts.push(`  from ${source}: ${check.detail}`);
  }
  return `${upstream} could not be copied to ${repository}:\n${attempts.join("\n")}`;
}

/**
 * Waits SETTLE_MS after copies the mirror held already were tagged, then
 * checks that each tag still names its copy, and puts back each one a prune
 * deleted, with the copy, as the tag went on. Returns what could not be put
 * back.
 *
 * The tag is what is checked, not the copy: another run may have made the
 * copy again meanwhile, under a tag of its own, and the copy would then be
 * there for as long as that run needs it, not this one. A tag that is gone is
 * put on the copy where the mirror has it, or on a new copy from the sources
 * where it has not, and is checked again SETTLE_MS later, as either can be a
 * tag on a version a prune is about to delete. A tag that names another
 * digest now was moved there by a later run of its own, which needs that
 * digest instead, and is left there.
 *
 * @param {{ image: { name: string, upstream: string }, tag: string }[]} tagged
 * @param {string} mirror
 * @param {{ runner?: Run, log?: (line: string) => void, sleep?: (ms: number) => void, settleMs?: number }} [options]
 * @returns {string[]}
 */
export function keepTagged(
  tagged,
  mirror,
  {
    runner = run,
    log = console.error,
    sleep = blockFor,
    settleMs = SETTLE_MS,
  } = {},
) {
  const failures = [];
  let pending = tagged;
  for (let round = 0; pending.length > 0; round += 1) {
    log(
      `Checking in ${settleMs / 1000} s that no prune deleted the copies just tagged.`,
    );
    sleep(settleMs);
    const restored = [];
    for (const entry of pending) {
      const { image, tag } = entry;
      const { digest } = hubImage(image.upstream);
      const repository = `${mirror}/${image.name}`;
      const named = manifestDigest(runner, `${repository}:${tag}`).digest;
      if (named === digest) {
        continue;
      }
      if (named !== undefined) {
        log(
          `${repository}:${tag} names ${named} now, not ${digest}: a later ` +
            "run moved it.",
        );
        continue;
      }
      if (round === RESTORES) {
        failures.push(
          `${repository}:${tag} was deleted with ${digest} each of the ` +
            `${RESTORES + 1} times it was put on it.`,
        );
        continue;
      }
      log(
        `${repository}:${tag} was deleted with ${digest} as it was put on ` +
          "it, so it is put back.",
      );
      if (
        served(runner, repository, digest).present &&
        tagCopy(runner, repository, digest, tag) === undefined
      ) {
        log(`Tagged ${repository}@${digest} ${tag} again.`);
        restored.push(entry);
        continue;
      }
      const failure = copyImage(image, mirror, tag, runner, log);
      if (failure === undefined) {
        restored.push(entry);
      } else {
        failures.push(failure);
      }
    }
    pending = restored;
  }
  return failures;
}

/**
 * Makes the mirror serve every image under its digest's tag (digestTag), or
 * under `tag` when it is given. Returns what could not be copied, one line
 * each.
 *
 * A copy the mirror serves already under other tags is given this one as
 * well; an image it does not serve is copied under it, as a registry needs a
 * tag to push to. CI never pulls by that tag, only by the digest. The tag is there
 * for scripts/prune-ci-mirror.mjs, which deletes a copy only pr-<number> tags
 * of closed pull requests hold: the digest's tag keeps a copy that a pin of
 * any branch has named for good, and a pr-<number> tag keeps it for that pull
 * request, which may use the copy another one had made. A copy given its tag
 * here may be one a prune is about to delete, so keepTagged makes sure no
 * prune deleted it, and the tag, meanwhile.
 *
 * Copies made before digestTag are under their pin's tag, or untagged when a
 * later copy took that over. They stay for the commits that still pin them:
 * deleting untagged versions of these packages breaks re-runs of those
 * commits until the daily run copies the pin on main again.
 *
 * @param {{ name: string, upstream: string, pull: string }[]} images
 * @param {string} mirror
 * @param {{ tag?: string, runner?: Run, log?: (line: string) => void, sleep?: (ms: number) => void, settleMs?: number }} [options]
 * @returns {string[]}
 */
export function mirrorImages(
  images,
  mirror,
  {
    tag: pushTag,
    runner = run,
    log = console.error,
    sleep = blockFor,
    settleMs = SETTLE_MS,
  } = {},
) {
  if (pushTag !== undefined && !TAG.test(pushTag)) {
    throw new Error(`${pushTag} is not a tag a registry accepts.`);
  }
  const failures = [];
  const tagged = [];
  for (const image of images) {
    const { digest } = hubImage(image.upstream);
    const tag = pushTag ?? digestTag(digest);
    const repository = `${mirror}/${image.name}`;
    if (manifestDigest(runner, `${repository}:${tag}`).digest === digest) {
      log(`${repository}@${digest} is mirrored already, tagged ${tag}.`);
      if (pushTag !== undefined) {
        // A pr-<number> tag is one a prune may be about to delete with the
        // copy, as it read the pull request as closed before this run, for a
        // reopened one, started. Only the digest's tag is safe from it.
        tagged.push({ image, tag });
      }
      continue;
    }
    const present = served(runner, repository, digest).present;
    if (present) {
      const refused = tagCopy(runner, repository, digest, tag);
      if (refused === undefined) {
        log(`${repository}@${digest} is mirrored already; tagged it ${tag}.`);
        tagged.push({ image, tag });
        continue;
      }
      log(
        `${repository}@${digest} could not be tagged ${tag}, so it is ` +
          `copied again: ${refused}`,
      );
    }
    const failure = copyImage(image, mirror, tag, runner, log);
    if (failure !== undefined) {
      failures.push(failure);
    } else if (present) {
      // The push put the tag on the version the mirror had, which a prune
      // may be deleting.
      tagged.push({ image, tag });
    }
  }
  return [
    ...failures,
    ...keepTagged(tagged, mirror, { runner, log, sleep, settleMs }),
  ];
}

/**
 * Waits until the mirror serves every image, and returns the ones it still
 * does not serve when `timeoutMs` has passed.
 *
 * A pin changed by a push to this repository is copied by the mirror workflow
 * that push starts, and one a pull request from a fork proposes by
 * ci-images-pr.yml, which the pull request starts; either runs at the same
 * time as CI, so a run may ask for a copy a minute or two before it exists.
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
          hubImage(image.upstream).digest,
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

/**
 * SETTLE_MS, or OPENBRF_MIRROR_SETTLE_SECONDS when it is set, which the tests
 * that run the scripts set to 0 so as not to wait a minute each.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
export function settleMsOf(env) {
  const seconds = env.OPENBRF_MIRROR_SETTLE_SECONDS;
  if (seconds === undefined || seconds === "") {
    return SETTLE_MS;
  }
  if (!/^\d+$/.test(seconds)) {
    throw new Error(
      `OPENBRF_MIRROR_SETTLE_SECONDS is ${seconds}, not a number of seconds.`,
    );
  }
  return Number(seconds) * 1000;
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
  const mirror = process.env.OPENBRF_IMAGE_MIRROR;
  try {
    const {
      positionals: [command, ...names],
      values: { "pins-from": pinsFrom, tag },
    } = parseArgs({
      allowPositionals: true,
      options: { "pins-from": { type: "string" }, tag: { type: "string" } },
    });
    if (command === "files") {
      process.stdout.write(`${PIN_FILES.join("\n")}\n`);
      process.exit(0);
    }
    // A pull request's files are read as text and nothing else: the patterns
    // in ciImages and hubImage decide what of them becomes a reference.
    const images = selectImages(
      ciImages(
        mirror,
        pinsFrom === undefined
          ? readRepoFile
          : (path) => readFileSync(join(pinsFrom, path), "utf8"),
      ),
      command === "wait" ? names : [],
    );
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
          : mirrorImages(images, mirror, {
              tag,
              settleMs: settleMsOf(process.env),
            });
      if (failures.length > 0) {
        throw new Error(
          command === "wait"
            ? "The CI image mirror does not serve these images:\n" +
                `${failures.join("\n")}\n\n` +
                "The Mirror CI images workflow copies a pin when a push to a " +
                "branch of this repository changes it, and every day. For a " +
                "pull request from a fork, the Mirror CI images for a pull " +
                "request workflow copies the pins it proposes: when its run " +
                "on the pull request has failed, its log says why, and once " +
                "it has passed, re-run the failed jobs here."
            : failures.join("\n\n"),
        );
      }
      process.stderr.write(
        command === "wait"
          ? `The CI image mirror serves ${images.map(({ pull }) => pull).join(", ")}.\n`
          : "Every CI image is mirrored.\n",
      );
    } else {
      throw new Error(
        "Usage: node scripts/ci-images.mjs refs | wait [name...] | " +
          "mirror [--pins-from <directory>] [--tag <tag>] | files",
      );
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
