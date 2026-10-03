import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { npmInstall, NpmInstallError } from "./npm-install";

const run = promisify(execFile);

/**
 * The installer's npm, for real, on an archive already on disk.
 *
 * The point is what npm does rather than what it is told: a package naming a
 * dependency must fail to install instead of having it fetched, however the
 * host's own npm is configured and whatever its cache already holds.
 */

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openbrf-npm-offline-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Packs a package and writes the staging package.json that names it. */
async function stageArchive(
  packageJson: Record<string, unknown>,
): Promise<string> {
  const source = join(directory, "source");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ version: "1.0.0", ...packageJson }),
    "utf8",
  );
  await writeFile(join(source, "index.js"), "module.exports = {};\n", "utf8");

  const staging = join(directory, "staging");
  const archives = join(staging, "archives");
  await mkdir(archives, { recursive: true });
  const { stdout } = await run(
    "npm",
    ["pack", "--json", "--pack-destination", archives],
    { cwd: source },
  );
  const packed = JSON.parse(stdout) as { filename: string }[];
  const name = packed[0]?.filename ?? "";

  await writeFile(
    join(staging, "package.json"),
    JSON.stringify({
      name: "openbrf-plugins",
      version: "0.0.0",
      private: true,
      dependencies: { [String(packageJson.name)]: `file:./archives/${name}` },
    }),
    "utf8",
  );
  return staging;
}

describe("npmInstall against a real npm", () => {
  it("installs a package that names nothing beyond itself", async () => {
    const staging = await stageArchive({ name: "openbrf-offline-plain" });

    await npmInstall({ cwd: staging });

    expect(await readdir(join(staging, "node_modules"))).toContain(
      "openbrf-offline-plain",
    );
  });

  it("installs a package that names the host's packages as peers", async () => {
    const staging = await stageArchive({
      name: "openbrf-offline-peers",
      peerDependencies: { "@nestjs/common": "^12.0.0", zod: "^4.6.2" },
    });

    await npmInstall({ cwd: staging });

    const installed = await readdir(join(staging, "node_modules"));
    expect(installed).toContain("openbrf-offline-peers");
    expect(installed).not.toContain("@nestjs");
  });

  it("refuses a package that names a dependency rather than fetching it", async () => {
    const staging = await stageArchive({
      name: "openbrf-offline-dependent",
      dependencies: { "left-pad": "1.3.0" },
    });

    await expect(npmInstall({ cwd: staging })).rejects.toBeInstanceOf(
      NpmInstallError,
    );
    const installed = await readdir(join(staging, "node_modules")).catch(
      () => [],
    );
    expect(installed).not.toContain("left-pad");
  });
});
