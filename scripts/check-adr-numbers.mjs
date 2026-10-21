/**
 * Refuses two records in docs/adr/ that carry the same number.
 *
 * Pull requests that each add a record are written against main, so they pick
 * the same next number, and because the files differ after the number git
 * merges them without a conflict. CI runs on the pull request's merge ref, so
 * a number that main has already taken fails the pull request that brings the
 * second file, before it merges.
 *
 * Two open pull requests that pick the same free number are not caught: the
 * second to merge fails on its next run against main, which is when it has to
 * renumber anyway.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The directory the records are kept in, relative to the repository root. */
const ADR_DIRECTORY = "docs/adr";

/**
 * The names of the files directly in a directory. A subdirectory such as
 * `0029-assets/` is not a record, so it does not share a number with one.
 *
 * @param {string} directory
 * @returns {string[]}
 */
export function recordFileNames(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

/**
 * What is wrong with the numbers of a list of file names, one sentence per
 * number that more than one file carries, naming every file that carries it.
 * A record's number is the four digits its file name starts with; any other
 * file is left alone.
 *
 * @param {string[]} fileNames
 * @returns {string[]}
 */
export function duplicateNumbers(fileNames) {
  const byNumber = new Map();
  for (const name of fileNames) {
    const number = /^(\d{4})-/.exec(name)?.[1];
    if (number !== undefined) {
      byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
    }
  }
  return [...byNumber]
    .filter(([, names]) => names.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([number, names]) =>
        `ADR ${number} is the number of more than one record: ` +
        `${[...names].sort().join(" and ")}. Renumber the one that is not on ` +
        "main to the next number after the highest in docs/adr/, and update " +
        "the links to it.",
    );
}

if (import.meta.main) {
  const names = recordFileNames(join(repoRoot, ADR_DIRECTORY));
  const failures = duplicateNumbers(names);
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`${failure}\n\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    `Every record in ${ADR_DIRECTORY}/ has a number of its own.\n`,
  );
}
