/**
 * Refuses a Postgres image whose digest has drifted from the one production
 * runs.
 *
 * The development database is meant to be the production one, and so is the
 * database every CI job tests against, which scripts/ci-images.mjs derives
 * from docker-compose.prod.yml: a database tested at one digest and shipped at
 * another is not the database that was tested. The registry in a reference may
 * differ; the tag and digest may not.
 *
 * Dependabot keeps the Compose files current, in one group, but a group does
 * not oblige it to move every reference together. This compares them instead
 * of trusting that.
 *
 * The Semgrep image is read from the one FROM line of docker/semgrep/Dockerfile,
 * which the scan workflow runs directly. It is not compared with anything, but
 * it must keep its digest, stay a semgrep/semgrep image and stay the only FROM,
 * or the workflow would run whatever the tag points at that day, another
 * repository's image, or the wrong one of two images. The workflow takes the
 * image from `--semgrep-image`, which prints it once it has passed those
 * checks, so that the guard and the workflow cannot read the line differently.
 *
 * Only the registry may differ: `name:tag@sha256:digest` must be identical in
 * every file below. Every file must also still carry a reference, so that a
 * rename cannot turn the check into one that compares nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The files that name the Postgres image the platform is developed and run on. */
const POSTGRES_FILES = ["docker-compose.prod.yml", "docker-compose.yml"];

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

/** The Dockerfile the Semgrep scan reads its image from. */
const SEMGREP_DOCKERFILE = "docker/semgrep/Dockerfile";

/**
 * The images named by the FROM instructions of a Dockerfile, with any
 * `--platform=` flag and `AS stage` alias left out. Comments are skipped.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function fromImagesOf(source) {
  return source
    .split("\n")
    .map((line) => /^\s*FROM\s+(?:--\S+\s+)*(?!--)(\S+)/i.exec(line)?.[1])
    .filter((image) => image !== undefined);
}

/**
 * How many FROM instructions a Dockerfile has, counting one that names no
 * image, which `fromImagesOf` leaves out.
 *
 * @param {string} source
 * @returns {number}
 */
export function fromLineCount(source) {
  return source.split("\n").filter((line) => /^\s*FROM(?:\s|$)/i.test(line))
    .length;
}

/**
 * What is wrong with the Semgrep Dockerfile's images, one sentence each; empty
 * when there is exactly one and it is pinned by digest.
 *
 * @param {string[]} images As returned by `fromImagesOf`.
 * @param {number} fromLines As returned by `fromLineCount`; defaults to the
 *   number of images.
 * @returns {string[]}
 */
export function semgrepFailures(images, fromLines = images.length) {
  if (fromLines !== 1 || images.length !== 1) {
    return [
      `${SEMGREP_DOCKERFILE} must have exactly one FROM line, the image the ` +
        `scan runs, and has ${String(fromLines)} FROM lines naming ` +
        `${String(images.length)} images.`,
    ];
  }
  if (!/@sha256:[0-9a-f]{64}$/.test(images[0])) {
    return [
      `The image on the FROM line of ${SEMGREP_DOCKERFILE} is not pinned by ` +
        `digest: ${images[0]}. Keep the \`name:tag@sha256:digest\` form, so ` +
        "the scan runs the image that was reviewed and not whatever the tag " +
        "points at when it runs.",
    ];
  }
  if (!SEMGREP_IMAGE_PATTERN.test(images[0])) {
    return [
      `The image on the FROM line of ${SEMGREP_DOCKERFILE} is not a ` +
        `semgrep/semgrep image: ${images[0]}. The scan workflow runs it with ` +
        "the code mounted, so it has to be the Semgrep image and no other.",
    ];
  }
  return [];
}

/**
 * The Semgrep image the scan workflow runs: `semgrep/semgrep:tag@sha256:digest`.
 * Without a registry, which the workflow puts in front of it.
 */
const SEMGREP_IMAGE_PATTERN = /^semgrep\/semgrep:[\w.-]+@sha256:[0-9a-f]{64}$/;

/**
 * The one image the scan workflow may run, read from the Semgrep Dockerfile.
 * Throws with every reason when the Dockerfile is not what the workflow can
 * trust, so that nothing but a validated reference reaches the caller.
 *
 * @param {string} source The Dockerfile's text.
 * @returns {string}
 */
export function semgrepImageOf(source) {
  const images = fromImagesOf(source);
  const failures = semgrepFailures(images, fromLineCount(source));
  if (failures.length > 0) {
    throw new Error(failures.join("\n\n"));
  }
  return images[0];
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
      "The Postgres image is not the same in every file that names it. The " +
        "registry may differ, but the tag and digest must match:\n" +
        lines.join("\n"),
    );
  }
  return failures;
}

/**
 * A file of the repository, or undefined when there is none at that path, so
 * that a moved file is reported with the list to update and not as a stack
 * trace.
 *
 * @param {string} path
 * @returns {string | undefined}
 */
function readRepoFile(path) {
  try {
    return readFileSync(join(repoRoot, path), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

if (import.meta.main) {
  const dockerfile = readRepoFile(SEMGREP_DOCKERFILE);
  const missing =
    `${SEMGREP_DOCKERFILE} does not exist. If it moved, update ` +
    "SEMGREP_DOCKERFILE in scripts/check-image-pins.mjs with it.";

  if (process.argv.includes("--semgrep-image")) {
    // Only the image goes to stdout, for the workflow to capture; a refusal
    // goes to stderr with a non-zero exit, and stdout stays empty.
    try {
      if (dockerfile === undefined) {
        throw new Error(missing);
      }
      process.stdout.write(`${semgrepImageOf(dockerfile)}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  const found = new Map(
    POSTGRES_FILES.map((path) => [
      path,
      pinsOf(readRepoFile(path) ?? "", "postgres"),
    ]),
  );
  const failures = [
    ...disagreements(found),
    ...(dockerfile === undefined
      ? [missing]
      : semgrepFailures(fromImagesOf(dockerfile), fromLineCount(dockerfile))),
  ];
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`${failure}\n\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    `Postgres is pinned identically in ${String(POSTGRES_FILES.length)} files, ` +
      "and the Semgrep image is pinned by digest.\n",
  );
}
