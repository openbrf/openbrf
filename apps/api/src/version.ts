import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which release of the platform this is, and which commit it was built from.
 *
 * The version is the package version of @openbrf/api, and it is the
 * platform's: the API, the web client, the translations and the shared code are
 * one fixed group in .changeset/config.json, so a release gives all four the
 * same version and any one of them names it. The image workflow
 * (.github/workflows/image.yml) refuses a tag that differs from it, so an image
 * says the version it was published under.
 *
 * The revision is the commit the image was built from. It arrives as a build
 * argument, because the image's build context carries no .git (.dockerignore),
 * and it is null in a process started from a checkout.
 */
export interface PlatformVersion {
  /** The fixed group's version, as apps/api/package.json states it. */
  readonly version: string;
  /** The full commit id the image was built from, or null. */
  readonly revision: string | null;
}

let current: PlatformVersion | undefined;

/** The platform's version and revision, read once and kept. */
export function platformVersion(): PlatformVersion {
  current ??= readPlatformVersion(process.env);
  return current;
}

/** What platformVersion() keeps, read from the given environment. */
export function readPlatformVersion(
  environment: NodeJS.ProcessEnv,
): PlatformVersion {
  return {
    version: packageVersion(),
    revision: nonEmpty(environment.OPENBRF_REVISION),
  };
}

/**
 * The line a starting instance writes to its log, so the first lines a
 * container prints say what it is. The image workflow's smoke test looks for
 * it. Twelve characters of the revision identify a commit in this repository
 * and fit on the line.
 */
export function platformVersionLine(platform: PlatformVersion): string {
  return platform.revision === null
    ? `Open BRF ${platform.version}`
    : `Open BRF ${platform.version} (${platform.revision.slice(0, 12)})`;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/**
 * apps/api, which holds package.json and prisma/ beside both dist/ and src/.
 *
 * Resolved from this file, which sits directly in dist/ or src/ whichever
 * entry point imported it. The API is CommonJS once built and ESM under
 * Vitest, and __dirname exists only in the first. Tests run from the package
 * root, which is the same directory, so the working directory is the fallback.
 */
export function apiPackageDirectory(): string {
  return typeof __dirname === "string" ? join(__dirname, "..") : process.cwd();
}

/** apps/api/package.json's version. */
function packageVersion(): string {
  const root = apiPackageDirectory();
  const manifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { name?: unknown; version?: unknown };
  if (
    manifest.name !== "@openbrf/api" ||
    typeof manifest.version !== "string" ||
    manifest.version === ""
  ) {
    throw new Error(
      `No @openbrf/api version in ${join(root, "package.json")}, so this ` +
        "process cannot say which release it is.",
    );
  }
  return manifest.version;
}
