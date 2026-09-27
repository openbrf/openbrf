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
 * On success it prints the directory of each package to publish, one per line,
 * for the release workflow to build and pack.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`::error::${problem}`);
  }
  process.exit(1);
}

for (const project of publicPackages) {
  console.log(relative(repoRoot, project.path));
}
