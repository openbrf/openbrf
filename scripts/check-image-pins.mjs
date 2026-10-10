/**
 * Refuses a CI image whose digest has drifted from the one production runs.
 *
 * CI pulls its images from registries that need no login, because Docker Hub
 * limits anonymous pulls per address and a pull request from a fork, or from
 * Dependabot, is given none of the repository's secrets. The registry in a
 * reference is therefore not the production file's, and the tag and digest are
 * meant to be: a database tested at one digest and shipped at another is not
 * the database that was tested.
 *
 * Dependabot keeps the Compose files current, in one group, but a group does
 * not oblige it to move every reference together, and no updater reads the
 * service image in ci.yml at all. This compares them instead of trusting that.
 *
 * Only the registry may differ: `name:tag@sha256:digest` must be identical in
 * every file below. Every file must also still carry a reference, so that a
 * rename cannot turn the check into one that compares nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The files that name the Postgres image the platform is tested and run on. */
const POSTGRES_FILES = [
  "docker-compose.prod.yml",
  "docker-compose.yml",
  "e2e/docker-compose.e2e.yml",
  ".github/workflows/ci.yml",
];

/**
 * The references to an image in a file, as `name:tag@sha256:digest` without the
 * registry in front of it. Lines that are comments are not references.
 *
 * @param {string} source
 * @param {string} name The image's name in its official-image form.
 * @returns {string[]}
 */
export function pinsOf(source, name) {
  const pattern = new RegExp(
    `^\\s*image:\\s*(?:[\\w.-]+(?::\\d+)?/(?:[\\w.-]+/)*)?(${name}:[\\w.-]+@sha256:[0-9a-f]{64})\\s*$`,
  );
  return source
    .split("\n")
    .map((line) => pattern.exec(line)?.[1])
    .filter((pin) => pin !== undefined);
}

/**
 * What is wrong with the pins found, one sentence each; empty when they agree.
 *
 * @param {Map<string, string[]>} found Pins by file path.
 * @returns {string[]}
 */
export function disagreements(found) {
  const failures = [];
  for (const [path, pins] of found) {
    if (pins.length === 0) {
      failures.push(
        `${path} names no Postgres image pinned by digest. If it moved, update ` +
          "POSTGRES_FILES in scripts/check-image-pins.mjs with it.",
      );
    }
  }
  const distinct = new Set([...found.values()].flat());
  if (distinct.size > 1) {
    const lines = [...found].map(
      ([path, pins]) => `  ${path}: ${pins.join(", ")}`,
    );
    failures.push(
      "The Postgres image is not the same in every file that names it. CI " +
        "pulls it from a different registry than production does, but the " +
        `tag and digest must match:\n${lines.join("\n")}`,
    );
  }
  return failures;
}

if (import.meta.main) {
  const found = new Map(
    POSTGRES_FILES.map((path) => [
      path,
      pinsOf(readFileSync(join(repoRoot, path), "utf8"), "postgres"),
    ]),
  );
  const failures = disagreements(found);
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`${failure}\n\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    `Postgres is pinned identically in ${String(POSTGRES_FILES.length)} files.\n`,
  );
}
