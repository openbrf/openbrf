/**
 * Clears the copies of pull requests out of the CI image mirror.
 *
 * .github/workflows/ci-images-pr.yml copies the images a pull request from a
 * fork pins under the tag pr-<number>. The pull request may pin any official
 * digest, so a fork can fill the mirror with old ones. Nothing is at risk from
 * that, because every pull is by digest, but the tags accumulate.
 *
 * The registry deletes package versions, never tags, and a version is a
 * digest with all its tags. That makes a prune more than "delete pr-*":
 *
 *  - ci-images.mjs mirror skips a digest the mirror serves under any tag. A
 *    digest that only a pr-<n> tag holds and a pin adopts later, say the pull
 *    request merged, would stay under that tag alone, and deleting the tag's
 *    version would delete the copy the pin names. So a pin's digest that only
 *    pr-* tags hold is tagged with the pin's own tag first, and is never
 *    deleted.
 *  - Only a version whose every tag is pr-<n> of a closed pull request is
 *    deleted: one that also holds another tag is somebody's copy, and the
 *    copy for a pull request still open is what its CI is about to pull.
 *  - A version with no tag is left alone, as mirrorImages in ci-images.mjs
 *    says: the commits that still pin it re-run against it. The platform
 *    images of an index are such versions.
 *
 *   node scripts/prune-ci-mirror.mjs            tags the pins pr-* tags alone hold
 *   node scripts/prune-ci-mirror.mjs --delete   and deletes the other pr-* copies
 *
 * Both read the pins from the repository checked out, so --delete belongs on
 * the default branch, whose pins are the ones CI needs; a run on another
 * branch only tags, which keeps that branch's pins for the day it merges.
 * OPENBRF_IMAGE_MIRROR names the mirror, GITHUB_TOKEN is the token that calls
 * the packages API and GITHUB_REPOSITORY (owner/name, set by Actions) is where
 * the pull requests are looked up. A workflow's token deletes package versions
 * only when the package gives the repository the Admin role.
 */
import { parseArgs } from "node:util";

import { ciImages, hubImage, run } from "./ci-images.mjs";

/** A tag the pull request workflow makes. `pr-007` is somebody else's. */
const PR_TAG = /^pr-([1-9]\d*)$/;

/**
 * @typedef {{ id: number, name: string, tags: string[] }} PackageVersion
 *   `name` is the digest.
 */

/**
 * Whether every tag of the version is a pull request's, and there is one.
 *
 * @param {PackageVersion} version
 * @returns {boolean}
 */
function heldByPullRequestsOnly({ tags }) {
  return tags.length > 0 && tags.every((tag) => PR_TAG.test(tag));
}

/**
 * What to do with the versions of one package, given the digest its pin names.
 *
 * @param {PackageVersion[]} versions
 * @param {string} pinned The digest the pin names.
 * @param {(number: number) => boolean} closed Whether the pull request is.
 * @returns {{ retag: boolean, remove: PackageVersion[] }} `retag`: the pin's
 *   copy has pr-* tags alone, so it needs the pin's own tag.
 */
export function prunePlan(versions, pinned, closed) {
  const pin = versions.find(({ name }) => name === pinned);
  return {
    retag: pin !== undefined && heldByPullRequestsOnly(pin),
    remove: versions.filter(
      (version) =>
        version.name !== pinned &&
        heldByPullRequestsOnly(version) &&
        version.tags.every((tag) => closed(Number(PR_TAG.exec(tag)[1]))),
    ),
  };
}

/**
 * A client of the packages and pull request endpoints of the GitHub API.
 *
 * @param {{ token: string, fetchFn?: typeof fetch, apiUrl?: string }} options
 */
export function githubClient({
  token,
  fetchFn = fetch,
  apiUrl = "https://api.github.com",
}) {
  const request = async (method, path) => {
    const response = await fetchFn(`${apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(
        `${method} ${path} answered ${response.status}: ` +
          (await response.text()).slice(0, 300),
      );
    }
    return response.status === 204 ? undefined : response.json();
  };
  const packagePath = (owner, name) =>
    `/orgs/${owner}/packages/container/${encodeURIComponent(name)}/versions`;
  return {
    /**
     * Every version of a container package, however many pages.
     *
     * @returns {Promise<PackageVersion[]>}
     */
    async versions(owner, name) {
      const versions = [];
      for (let page = 1; ; page += 1) {
        const batch = await request(
          "GET",
          `${packagePath(owner, name)}?per_page=100&page=${page}`,
        );
        versions.push(
          ...batch.map(({ id, name: digest, metadata }) => ({
            id,
            name: digest,
            tags: metadata?.container?.tags ?? [],
          })),
        );
        if (batch.length < 100) {
          return versions;
        }
      }
    },
    async deleteVersion(owner, name, id) {
      await request("DELETE", `${packagePath(owner, name)}/${id}`);
    },
    /**
     * Only a pull request the API says is closed is closed: an answer that
     * fails, or names a state not seen before, keeps its copy.
     *
     * @returns {Promise<boolean>}
     */
    async closed(repository, number) {
      const pull = await request("GET", `/repos/${repository}/pulls/${number}`);
      return pull.state === "closed";
    },
  };
}

/**
 * The registry host, the owner and the package path of a mirror
 * (`ghcr.io/openbrf/ci-mirror`) and an image in it.
 *
 * @param {string} mirror
 * @param {string} name
 * @returns {{ owner: string, packageName: string }}
 */
function packageOf(mirror, name) {
  const [host, owner, ...path] = mirror.split("/");
  if (host !== "ghcr.io" || owner === undefined || path.length === 0) {
    throw new Error(
      `OPENBRF_IMAGE_MIRROR is ${mirror}; only a package of an organization ` +
        "on ghcr.io, such as ghcr.io/openbrf/ci-mirror, can be pruned.",
    );
  }
  return { owner, packageName: [...path, name].join("/") };
}

/**
 * Tags the pins that pr-* tags alone hold and, with `remove`, deletes the
 * other copies of closed pull requests. Returns what failed, one line each.
 *
 * @param {{ name: string, upstream: string }[]} images
 * @param {string} mirror
 * @param {{ client: ReturnType<typeof githubClient>, repository: string, remove?: boolean, runner?: import("./ci-images.mjs").Run, log?: (line: string) => void }} options
 * @returns {Promise<string[]>}
 */
export async function pruneMirror(
  images,
  mirror,
  { client, repository, remove = false, runner = run, log = console.error },
) {
  const failures = [];
  const states = new Map();
  for (const { name, upstream } of images) {
    const { tag, digest } = hubImage(upstream);
    const target = `${mirror}/${name}`;
    try {
      const { owner, packageName } = packageOf(mirror, name);
      const versions = await client.versions(owner, packageName);
      // Looked up once per pull request, and only for the ones whose copy the
      // rest of the rule would delete.
      for (const version of versions) {
        if (version.name === digest || !heldByPullRequestsOnly(version)) {
          continue;
        }
        for (const prTag of version.tags) {
          const number = Number(PR_TAG.exec(prTag)[1]);
          if (!states.has(number)) {
            states.set(number, await client.closed(repository, number));
          }
        }
      }
      const plan = prunePlan(versions, digest, (number) => states.get(number));
      if (plan.retag) {
        const copy = runner("skopeo", [
          "copy",
          "--all",
          "--preserve-digests",
          `docker://${target}@${digest}`,
          `docker://${target}:${tag}`,
        ]);
        if (copy.status !== 0) {
          throw new Error(
            `${target}@${digest} could not be tagged ${tag}: ${copy.stderr.trim()}`,
          );
        }
        log(`Tagged ${target}@${digest} ${tag}, which a pin names.`);
      }
      for (const version of plan.remove) {
        const what = `${target}@${version.name} (${version.tags.join(", ")})`;
        if (remove) {
          await client.deleteVersion(owner, packageName, version.id);
          log(`Deleted ${what}.`);
        } else {
          log(`Would delete ${what}.`);
        }
      }
    } catch (error) {
      failures.push(`${target}: ${error.message}`);
    }
  }
  return failures;
}

if (import.meta.main) {
  try {
    const {
      values: { delete: remove },
    } = parseArgs({ options: { delete: { type: "boolean" } } });
    const { OPENBRF_IMAGE_MIRROR: mirror, GITHUB_TOKEN: token } = process.env;
    const repository = process.env.GITHUB_REPOSITORY;
    for (const [name, value] of Object.entries({
      OPENBRF_IMAGE_MIRROR: mirror,
      GITHUB_TOKEN: token,
      GITHUB_REPOSITORY: repository,
    })) {
      if (value === undefined || value === "") {
        throw new Error(`${name} is not set.`);
      }
    }
    const failures = await pruneMirror(ciImages(mirror), mirror, {
      client: githubClient({ token }),
      repository,
      remove,
    });
    if (failures.length > 0) {
      throw new Error(failures.join("\n"));
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
