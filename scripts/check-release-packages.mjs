/**
 * Refuses a release whose packages or versions are not the ones ADR 0020 names.
 *
 * A version on npmjs.com is published once and can never be published again,
 * so a wrong one is a mistake the project carries for good. Three are worth
 * refusing before anything is built:
 *
 *   A public package nobody decided to publish. The release publishes every
 *   workspace package that is not `private`, so dropping that flag from a
 *   fourth package would publish it on the next run without anybody having
 *   decided to. Every public package must be listed below with the rule its
 *   major version follows, and every listed package must be public.
 *
 *   A package still at 0.0.0, the placeholder the packages carry until their
 *   first `pnpm changeset version`. Publishing it would spend that version on
 *   whatever main happens to hold.
 *
 *   A major that is not the contract's. The SDK's major version is the plugin
 *   API version and the theme tools' is the token contract's (ADR 0020), so an
 *   author reads from the version alone which hosts a package works with. A
 *   changeset of the wrong kind would break that silently. The tokens package
 *   is the contract itself, so its major follows the contract's too.
 *
 *   A pending changeset that names a package to publish. Its change is in the
 *   code but not yet in the version or the CHANGELOG, so publishing now would
 *   ship it under a version whose notes leave it out. `pnpm changeset version`
 *   consumes the changesets first.
 *
 * On success it prints the directory of each package to publish, one per line,
 * dependencies before the packages that depend on them, for the release
 * workflow to build, pack and publish in that order: a package is never on the
 * registry before a version of every package it needs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_API_VERSION } from "../packages/plugin-sdk/src/api-version.ts";
import { TOKEN_CONTRACT_VERSION } from "../packages/tokens/src/contract.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const tokenContractMajor = Number(TOKEN_CONTRACT_VERSION.split(".")[0]);

/** Every package the release may publish, and the major it must carry. */
const PUBLISHED = new Map([
  [
    "@openbrf/plugin-sdk",
    { major: PLUGIN_API_VERSION, source: "PLUGIN_API_VERSION" },
  ],
  [
    "@openbrf/theme-tools",
    { major: tokenContractMajor, source: "TOKEN_CONTRACT_VERSION" },
  ],
  [
    "@openbrf/tokens",
    { major: tokenContractMajor, source: "TOKEN_CONTRACT_VERSION" },
  ],
]);

const workspace = JSON.parse(
  execFileSync("pnpm", ["-r", "ls", "--json", "--depth", "-1"], {
    cwd: repoRoot,
    encoding: "utf8",
  }),
);
const publicPackages = workspace.filter((project) => !project.private);

const problems = [];

for (const project of publicPackages) {
  if (!PUBLISHED.has(project.name)) {
    problems.push(
      `${project.name} is not private, but the release has no rule for it. Mark it private, or add it to scripts/check-release-packages.mjs.`,
    );
  }
}

for (const [name, rule] of PUBLISHED) {
  const project = publicPackages.find((candidate) => candidate.name === name);
  if (project === undefined) {
    problems.push(
      `${name} is listed for release but is private or missing from the workspace.`,
    );
    continue;
  }
  const { version } = JSON.parse(
    readFileSync(join(project.path, "package.json"), "utf8"),
  );
  if (version === "0.0.0") {
    problems.push(
      `${name} is at 0.0.0. Run \`pnpm changeset version\` in a pull request first.`,
    );
    continue;
  }
  const major = Number(version.split(".")[0]);
  if (major !== rule.major) {
    problems.push(
      `${name} is at ${version}, but its major must be ${rule.major}, the major of ${rule.source}.`,
    );
  }
}

const changesetDirectory = join(repoRoot, ".changeset");
for (const file of readdirSync(changesetDirectory).sort()) {
  if (!file.endsWith(".md") || file === "README.md") {
    continue;
  }
  const names = changesetPackages(
    readFileSync(join(changesetDirectory, file), "utf8"),
  );
  if (names === null) {
    problems.push(
      `.changeset/${file} could not be read as a changeset, so the release cannot tell which packages it names. Its front matter must be a \`---\` line, one \`"package": bump\` line per package and a closing \`---\` line, with no byte order mark.`,
    );
    continue;
  }
  for (const name of names) {
    if (PUBLISHED.has(name)) {
      problems.push(
        `.changeset/${file} names ${name}, which is not versioned yet. Run \`pnpm changeset version\` in a pull request first.`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`::error::${problem}`);
  }
  process.exit(1);
}

for (const project of dependenciesFirst(publicPackages)) {
  console.log(relative(repoRoot, project.path));
}

/**
 * The package names in a changeset's front matter, or null when it is not the
 * plain list of `"package": bump` lines that `pnpm changeset` writes.
 *
 * The front matter is YAML, which Changesets reads with a full parser. This
 * check runs before any dependency is installed, so it reads only that plain
 * shape and refuses anything else: a file it misread could let a pending
 * change through unnoticed, while a refused one only needs rewriting.
 */
function changesetPackages(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    return null;
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    return null;
  }
  const names = [];
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") {
      continue;
    }
    const entry =
      /^\s*(["']?)([^"'\s:]+)\1\s*:\s*(major|minor|patch|none)\s*$/.exec(line);
    if (entry === null) {
      return null;
    }
    names.push(entry[2]);
  }
  return names;
}

/**
 * The projects ordered so that each comes after every other one it depends
 * on, and otherwise by name. The published packages have no cycle, as a
 * workspace with one would not build.
 */
function dependenciesFirst(projects) {
  const byName = new Map(projects.map((project) => [project.name, project]));
  const ordered = [];
  const visited = new Set();
  const visit = (project) => {
    if (visited.has(project.name)) {
      return;
    }
    visited.add(project.name);
    const manifest = JSON.parse(
      readFileSync(join(project.path, "package.json"), "utf8"),
    );
    const needs = Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    }).sort();
    for (const name of needs) {
      const dependency = byName.get(name);
      if (dependency !== undefined) {
        visit(dependency);
      }
    }
    ordered.push(project);
  };
  for (const project of [...projects].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    visit(project);
  }
  return ordered;
}
