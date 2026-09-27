/**
 * Publishes the packages a plugin or theme author builds against to npm:
 * `@openbrf/tokens`, `@openbrf/theme-tools` and `@openbrf/plugin-sdk`.
 *
 * Each package is taken in turn, in dependency order: theme-tools depends on
 * the tokens, so the tokens go first. A version the registry already has is
 * skipped, which is what makes a run that stopped halfway safe to run again.
 * Anything else is packed with pnpm, which rewrites `workspace:` ranges into
 * the versions they point at; the tarball is checked for the files a published
 * package has to carry; and that same tarball, the bytes that were checked, is
 * what npm publishes, with provenance.
 *
 * Run by .github/workflows/release.yml after the three packages are built and
 * tested. It builds nothing itself, so `dist/` has to be current.
 *
 * Options:
 *
 *   --dry-run   Do everything except publish: ask the registry, pack, check,
 *               and list each tarball's contents.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Package directories under packages/, in the order they are published. */
const PACKAGES = ["tokens", "theme-tools", "plugin-sdk"];

/**
 * Kept once, at the repository root, and copied into each package before it
 * is packed. Every published package is AGPL-3.0-only, and a plugin or theme
 * built against it is a module under the exception, so a tarball without
 * either file would misstate what its user may do.
 */
const ROOT_FILES = ["LICENSE", "LICENSE-EXCEPTION.md"];

/** What every tarball holds, besides the files its manifest's entry points name. */
const REQUIRED_FILES = ["package.json", "README.md", ...ROOT_FILES];

const { values: options } = parseArgs({
  options: { "dry-run": { type: "boolean", default: false } },
});
const dryRun = options["dry-run"];

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function capture(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

/**
 * The registry named twice: as the default, and for the package's scope. A
 * scoped package goes to `<scope>:registry` whenever a user configuration sets
 * one, ahead of `--registry`, so a machine still pointing the scope at another
 * registry would otherwise be the one asked and published to.
 */
function registryArgs(name, registry) {
  const scope = name.split("/")[0];
  return [
    "--registry",
    registry,
    `--${scope}:registry=${registry}`,
    "--no-update-notifier",
  ];
}

/**
 * Whether the registry already has this exact version. The registry answers
 * E404 both for a package it has never seen and for a version of a known one
 * it does not have; any other failure is not an answer, and stops the run
 * rather than being read as "not published".
 */
function isPublished(name, version, registry) {
  const result = spawnSync(
    "npm",
    [
      "view",
      `${name}@${version}`,
      "version",
      "--json",
      ...registryArgs(name, registry),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status === 0) {
    return result.stdout.trim() !== "";
  }
  let code;
  try {
    code = JSON.parse(result.stdout).error?.code;
  } catch {
    code = undefined;
  }
  if (code === "E404") {
    return false;
  }
  throw new Error(
    `Could not ask ${registry} whether ${name}@${version} is published:\n` +
      `${result.stderr}${result.stdout}`,
  );
}

/** The files a manifest's `main`, `types` and `exports` name. */
function entryPoints(manifest) {
  const paths = [];
  const collect = (value) => {
    if (typeof value === "string") {
      paths.push(value.replace(/^\.\//, ""));
    } else if (value !== null && typeof value === "object") {
      Object.values(value).forEach(collect);
    }
  };
  collect([manifest.main, manifest.types, manifest.exports]);
  return paths;
}

/** Every reason this tarball must not be published, or none. */
function tarballProblems(files, manifest) {
  const problems = [];
  for (const path of new Set([...REQUIRED_FILES, ...entryPoints(manifest)])) {
    if (!files.includes(path)) {
      problems.push(`${path} is not in the tarball.`);
    }
  }
  if (manifest.private === true) {
    problems.push("The packed manifest is private.");
  }
  for (const field of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (range.startsWith("workspace:")) {
        problems.push(
          `${field} names ${name} as ${range}, which no registry resolves.`,
        );
      }
    }
  }
  return problems;
}

function publishPackage(directoryName, destination) {
  const directory = join(repoRoot, "packages", directoryName);
  const source = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  const { name, version } = source;
  const registry = source.publishConfig?.registry;
  if (registry === undefined) {
    throw new Error(`${name} has no publishConfig.registry to publish to.`);
  }

  if (isPublished(name, version, registry)) {
    console.log(`${name}@${version} is already on ${registry}; skipped.`);
    return;
  }

  for (const file of ROOT_FILES) {
    copyFileSync(join(repoRoot, file), join(directory, file));
  }

  const packed = JSON.parse(
    capture(
      "pnpm",
      ["pack", "--json", "--pack-destination", destination],
      directory,
    ),
  );
  const tarball = packed.filename;

  // Read from the tarball itself rather than from pnpm's account of it, so
  // what is checked is exactly what npm is handed below.
  const files = capture("tar", ["-tzf", tarball], repoRoot)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(/^package\//, ""))
    .sort();
  const manifest = JSON.parse(
    capture("tar", ["-xzOf", tarball, "package/package.json"], repoRoot),
  );

  console.log(`${name}@${version}: ${tarball}`);
  for (const file of files) {
    console.log(`  ${file}`);
  }

  const problems = tarballProblems(files, manifest);
  if (problems.length > 0) {
    throw new Error(
      `${name}@${version} is not fit to publish:\n  ${problems.join("\n  ")}`,
    );
  }

  if (dryRun) {
    console.log(`${name}@${version} would be published to ${registry}.`);
    return;
  }

  run(
    "npm",
    [
      "publish",
      tarball,
      "--provenance",
      "--access",
      "public",
      ...registryArgs(name, registry),
    ],
    repoRoot,
  );
  console.log(`${name}@${version} published to ${registry}.`);
}

const destination = mkdtempSync(join(tmpdir(), "openbrf-packages-"));
try {
  for (const directoryName of PACKAGES) {
    publishPackage(directoryName, destination);
  }
} finally {
  rmSync(destination, { recursive: true, force: true });
}

if (dryRun) {
  console.log("Dry run: nothing was published.");
}
