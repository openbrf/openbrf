/**
 * Prints the release notes for one version of the platform.
 *
 *   node scripts/release-notes.mjs 0.1.0 > notes.md
 *
 * The platform is the fixed group in .changeset/config.json. A release gives
 * every package in it the same version, and `changeset version` writes each
 * changeset into the changelog of the packages it names - so a change to the
 * web client alone is in the web client's CHANGELOG.md and nowhere else. The
 * notes are therefore gathered from every package in the group: the section
 * for this version from each, an entry two packages share given once, the
 * dependency bumps between the group's own packages left out, and major
 * changes before minor ones before patches. A bump of a package outside the
 * group - the design tokens, the plugin SDK - is kept, because a release can
 * consist of nothing else.
 *
 * Exits 1 when a package in the group has no section for the version. The
 * group is released together, so that is a changelog nobody generated for this
 * release, not a package with nothing to say.
 *
 * Node built-ins only: the image workflow (.github/workflows/image.yml) runs
 * it on a checkout with nothing installed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The headings `changeset version` groups entries under, most significant first. */
const KINDS = ["Major Changes", "Minor Changes", "Patch Changes"];

/** What `changeset version` writes for a bump inside the workspace. */
const DEPENDENCY_BUMP = "- Updated dependencies";

/** One line of a dependency bump: `  - @openbrf/tokens@0.2.0`. */
const BUMPED_PACKAGE = /^\s+- (@?[^@\s]+)@\S+$/;

/**
 * A dependency bump with the group's own packages taken out, or undefined when
 * it named nothing else. The commit list after the heading is dropped as well,
 * so the same bump reads the same whichever package's changelog carried it.
 */
function outsideBumps(entry, group) {
  const bumped = entry
    .split("\n")
    .slice(1)
    .filter((line) => {
      const name = BUMPED_PACKAGE.exec(line)?.[1];
      return name !== undefined && !group.has(name);
    })
    .map((line) => `  ${line.trim()}`);
  return bumped.length === 0
    ? undefined
    : [DEPENDENCY_BUMP, ...bumped].join("\n");
}

/** The lines of one changelog's `## <version>` section, or undefined. */
function versionSection(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) {
    return undefined;
  }
  const next = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );
  return lines.slice(start + 1, next === -1 ? lines.length : next);
}

/**
 * One section's entries under each of the three headings.
 *
 * An entry is a line opening a list item and every line after it up to the
 * next item or heading: a changeset's later paragraphs are indented under its
 * first. Trailing blank lines and trailing spaces are not part of it, so the
 * same changeset reads the same in every changelog it reached.
 */
function entriesByKind(section) {
  const kinds = new Map(KINDS.map((kind) => [kind, []]));
  let current;
  let entry;
  const close = () => {
    if (entry !== undefined && current !== undefined) {
      current.push(
        entry
          .map((line) => line.trimEnd())
          .join("\n")
          .replace(/\n+$/, ""),
      );
    }
    entry = undefined;
  };

  for (const line of section) {
    const heading = /^### (.+)$/.exec(line);
    if (heading !== null) {
      close();
      current = kinds.get(heading[1].trim());
    } else if (line.startsWith("- ")) {
      close();
      entry = [line];
    } else if (entry !== undefined) {
      entry.push(line);
    }
  }
  close();
  return kinds;
}

/**
 * The notes for one version, from the changelogs of the group's packages.
 *
 * @param {string} version A plain MAJOR.MINOR.PATCH.
 * @param {{ name: string, text: string }[]} changelogs In the group's order.
 * @param {string[]} [group] Every package in the group, when changelogs is
 *   not all of them.
 * @returns {string} Markdown.
 */
export function releaseNotes(
  version,
  changelogs,
  group = changelogs.map(({ name }) => name),
) {
  const inGroup = new Set(group);
  const sections = changelogs.map(({ name, text }) => {
    const section = versionSection(text, version);
    if (section === undefined) {
      throw new Error(
        `${name} has no section for ${version} in its changelog.`,
      );
    }
    return entriesByKind(section);
  });

  const seen = new Set();
  const parts = [];
  for (const kind of KINDS) {
    const entries = [];
    for (const section of sections) {
      for (const written of section.get(kind) ?? []) {
        const entry = written.startsWith(DEPENDENCY_BUMP)
          ? outsideBumps(written, inGroup)
          : written;
        if (entry === undefined || seen.has(entry)) {
          continue;
        }
        seen.add(entry);
        entries.push(entry);
      }
    }
    if (entries.length > 0) {
      parts.push(`## ${kind}\n\n${entries.join("\n\n")}`);
    }
  }
  return parts.length === 0
    ? "No change is recorded for this release.\n"
    : `${parts.join("\n\n")}\n`;
}

function fail(message) {
  console.error(`release-notes: ${message}`);
  process.exit(1);
}

/** Every workspace package's name and directory, from apps/ and packages/. */
function workspacePackages() {
  const packages = new Map();
  for (const parent of ["apps", "packages"]) {
    for (const entry of readdirSync(join(repoRoot, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = join(repoRoot, parent, entry.name);
      try {
        const { name } = JSON.parse(
          readFileSync(join(directory, "package.json"), "utf8"),
        );
        packages.set(name, directory);
      } catch {
        // A directory without a package.json is not a workspace package.
      }
    }
  }
  return packages;
}

if (import.meta.main) {
  const version = process.argv[2];
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(
      "takes one version, a plain MAJOR.MINOR.PATCH such as 0.1.0, and " +
        `was given ${String(version)}.`,
    );
  }

  const config = JSON.parse(
    readFileSync(join(repoRoot, ".changeset", "config.json"), "utf8"),
  );
  const group = config.fixed?.[0];
  if (!Array.isArray(group) || group.length === 0) {
    fail(
      ".changeset/config.json names no fixed group, so there is no platform.",
    );
  }

  const directories = workspacePackages();
  const changelogs = group.map((name) => {
    const directory = directories.get(name);
    if (directory === undefined) {
      fail(
        `${name} is in the fixed group but is no package in this workspace.`,
      );
    }
    try {
      return {
        name,
        text: readFileSync(join(directory, "CHANGELOG.md"), "utf8"),
      };
    } catch {
      return fail(`${name} has no CHANGELOG.md, so ${version} has no notes.`);
    }
  });

  try {
    process.stdout.write(releaseNotes(version, changelogs));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
