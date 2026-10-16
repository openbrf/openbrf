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
 *  - Only a version whose every tag is pr-<n> of a closed pull request is
 *    deleted: one that also holds another tag is somebody's copy, and the
 *    copy for a pull request still open is what its CI is about to pull.
 *    That a pull request's pin uses a copy shows only in its tag, so
 *    ci-images.mjs mirror puts pr-<n> on a copy the mirror has already too.
 *  - That a branch's pin uses a copy shows in the tag of its digest
 *    (digestTag in ci-images.mjs), which ci-images.mjs mirror puts on the
 *    copy on every branch, a copy a pull request had made included, say one
 *    a Dependabot bump adopts. No run moves that tag to another digest, as
 *    one would the pin's own tag, so the copy keeps it, and is kept, for as
 *    long as the registry has it. The digest the checked-out pin names is
 *    never deleted either, as the merge that adopts it prunes before its
 *    mirror step tags it.
 *  - A version with no tag is left alone, as mirrorImages in ci-images.mjs
 *    says: the commits that still pin it re-run against it. The platform
 *    images of an index are such versions.
 *
 * Other branches and pull requests tag copies while this runs, and the
 * registry cannot delete a version only if its tags are still the ones read.
 * So the tags of each version are read again just before it is deleted, and
 * it is kept when they changed or the reading took longer than a sixth of
 * SETTLE_MS. A run that adds a tag the moment after that reading loses the
 * copy and the tag, so every run that tags a copy the mirror has checks
 * SETTLE_MS later that its tag still names the copy, and puts it back if not:
 * another run may have made the copy again by then under its own tag, which
 * keeps the copy only as long as that run needs it.
 *
 *   node scripts/prune-ci-mirror.mjs            says what it would delete
 *   node scripts/prune-ci-mirror.mjs --delete   and deletes it
 *
 * The pin is read from the repository checked out, so --delete belongs on the
 * default branch, whose pins are the ones CI needs. Runs on the same branch
 * never overlap, as the workflow has them wait for each other.
 * OPENBRF_IMAGE_MIRROR names the mirror, GITHUB_TOKEN is the token that calls
 * the packages API and GITHUB_REPOSITORY (owner/name, set by Actions) is where
 * the pull requests are looked up. A workflow's token deletes package versions
 * only when the package gives the repository the Admin role.
 */
import { parseArgs } from "node:util";

import { SETTLE_MS, ciImages, hubImage } from "./ci-images.mjs";

/** A tag the pull request workflow makes. `pr-007` is somebody else's. */
const PR_TAG = /^pr-([1-9]\d*)$/;

/**
 * The longest a reading of a version's tags may take for a deletion to go
 * ahead on it. keepTagged waits six times this before it checks a copy.
 */
const REREAD_LIMIT_MS = SETTLE_MS / 6;

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
 * The versions of one package to delete, given the digest its pin names.
 *
 * @param {PackageVersion[]} versions
 * @param {string} pinned The digest the pin names.
 * @param {(number: number) => boolean} closed Whether the pull request is.
 * @returns {PackageVersion[]}
 */
export function prunePlan(versions, pinned, closed) {
  return versions.filter(
    (version) =>
      version.name !== pinned &&
      heldByPullRequestsOnly(version) &&
      version.tags.every((tag) => closed(Number(PR_TAG.exec(tag)[1]))),
  );
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
  const versionOf = ({ id, name: digest, metadata }) => ({
    id,
    name: digest,
    tags: metadata?.container?.tags ?? [],
  });
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
        versions.push(...batch.map(versionOf));
        if (batch.length < 100) {
          return versions;
        }
      }
    },
    /**
     * One version of a container package, as it is now.
     *
     * @returns {Promise<PackageVersion>}
     */
    async version(owner, name, id) {
      return versionOf(
        await request("GET", `${packagePath(owner, name)}/${id}`),
      );
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
 * Whether two lists hold the same tags, in whatever order.
 *
 * @param {string[]} tags
 * @param {string[]} others
 * @returns {boolean}
 */
function sameTags(tags, others) {
  return (
    tags.length === others.length && tags.every((tag) => others.includes(tag))
  );
}

/**
 * With `remove`, deletes the copies of closed pull requests, and without it
 * says which. Returns what failed, one line each.
 *
 * @param {{ name: string, upstream: string }[]} images
 * @param {string} mirror
 * @param {{ client: ReturnType<typeof githubClient>, repository: string, remove?: boolean, log?: (line: string) => void, now?: () => number }} options
 * @returns {Promise<string[]>}
 */
export async function pruneMirror(
  images,
  mirror,
  { client, repository, remove = false, log = console.error, now = Date.now },
) {
  const failures = [];
  const states = new Map();
  for (const { name, upstream } of images) {
    const { digest } = hubImage(upstream);
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
      const doomed = prunePlan(versions, digest, (number) =>
        states.get(number),
      );
      for (const version of doomed) {
        const what = `${target}@${version.name} (${version.tags.join(", ")})`;
        if (!remove) {
          log(`Would delete ${what}.`);
          continue;
        }
        // Nothing is awaited between this reading and the deletion but the
        // deletion itself.
        const started = now();
        const current = await client.version(owner, packageName, version.id);
        if (now() - started > REREAD_LIMIT_MS) {
          log(`Kept ${what}: its tags took too long to read again.`);
        } else if (
          current.name !== version.name ||
          !sameTags(current.tags, version.tags)
        ) {
          log(
            `Kept ${what}: its tags are ${current.tags.join(", ") || "none"} now.`,
          );
        } else {
          await client.deleteVersion(owner, packageName, version.id);
          log(`Deleted ${what}.`);
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
