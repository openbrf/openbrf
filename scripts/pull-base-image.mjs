/**
 * Pulls the Dockerfile's base image for scripts/dockerfile-guards.test.mjs.
 *
 * ECR Public limits anonymous pulls per address and the CI runners share
 * theirs, so the image comes from Google's mirror of the Docker official images
 * first and from the registry the Dockerfile names second, each tried a few
 * times. The reference keeps the Dockerfile's tag and digest, so the mirror
 * cannot serve a different image under it.
 */
import { spawnSync } from "node:child_process";

export const MIRROR = "mirror.gcr.io";
export const PULL_ATTEMPTS = 3;
export const PULL_TIMEOUT_MS = 120_000;

/**
 * The references the base image can be pulled by, in the order to try them:
 * the mirror's copy of an ECR Public official image, then the Dockerfile's own.
 *
 * @param {string} image
 * @returns {string[]}
 */
export function pullCandidates(image) {
  const official = /^public\.ecr\.aws\/docker\/(library\/.+)$/.exec(image);
  return official ? [`${MIRROR}/${official[1]}`, image] : [image];
}

/**
 * Pauses the thread for `ms` milliseconds.
 *
 * @param {number} ms
 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Pulls the base image, retrying with a growing pause, and returns the
 * reference that worked. Throws with what Docker said when none does.
 *
 * An attempt that takes longer than `timeout` is killed and counts as failed,
 * so a stalled connection moves on to the next attempt and registry instead of
 * holding the job.
 *
 * @param {string} image
 * @param {{ pause?: (ms: number) => void, timeout?: number }} [options]
 *   `pause` and `timeout` are replaced by the tests, which have no time to wait.
 * @returns {string}
 */
export function pullBaseImage(
  image,
  { pause = sleep, timeout = PULL_TIMEOUT_MS } = {},
) {
  const failures = [];
  for (const reference of pullCandidates(image)) {
    for (let attempt = 1; attempt <= PULL_ATTEMPTS; attempt += 1) {
      const pull = spawnSync("docker", ["pull", "--quiet", reference], {
        encoding: "utf8",
        timeout,
      });
      if (pull.status === 0) return reference;
      failures.push(
        `${reference}, attempt ${attempt}: ${pull.stdout}${pull.stderr}${pull.error ?? ""}`.trim(),
      );
      if (attempt < PULL_ATTEMPTS) pause(2000 * attempt);
    }
  }
  throw new Error(`Could not pull the base image:\n${failures.join("\n")}`);
}
