import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Running npm against an installation directory.
 *
 * npm rather than pnpm, and that is a decision rather than an oversight: pnpm's
 * isolated layout makes the module-resolution assumptions the loader depends on
 * unreliable, so the production image has to carry the npm CLI (ADR 0003).
 *
 * --omit=peer is the load-bearing flag. npm 7 and later installs
 * peerDependencies automatically, which would place a second copy of
 * @nestjs/common beside the plugin; a second copy breaks dependency injection
 * in ways that surface late and confusingly, and the NODE_PATH bridge does not
 * help because a sibling copy wins over NODE_PATH. The loader's module identity
 * assertion is the second half of that defence - either one alone is
 * insufficient.
 */

export class NpmInstallError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "NpmInstallError";
  }
}

export interface NpmInstallOptions {
  /** Directory holding the package.json that names the desired dependencies. */
  cwd: string;
  /** Wall-clock ceiling. An install that hangs must not hang the queue. */
  timeoutMilliseconds?: number;
  /** Overridden in tests. */
  npmPath?: string;
}

const DEFAULT_TIMEOUT = 5 * 60_000;

export async function npmInstall(options: NpmInstallOptions): Promise<void> {
  const args = [
    "install",
    // See the note above: this is why a plugin can share the host's NestJS.
    "--omit=peer",
    "--omit=dev",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
    // A plugin's own code runs at full process privilege once it is loaded, so
    // this is not a sandbox. What it does buy is that nothing executes between
    // the download and the board's consent taking effect: an install that is
    // going to be refused by the manifest gate, or abandoned halfway, has not
    // already run a postinstall script.
    "--ignore-scripts",
    "--loglevel=error",
  ];

  try {
    await run(options.npmPath ?? "npm", args, {
      cwd: options.cwd,
      timeout: options.timeoutMilliseconds ?? DEFAULT_TIMEOUT,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        // The installer resolves nothing from a registry, so a stray NODE_PATH
        // or npm config from the host process must not change what it does.
        NODE_PATH: "",
        npm_config_update_notifier: "false",
      },
    });
  } catch (cause) {
    const stderr =
      typeof cause === "object" && cause !== null && "stderr" in cause
        ? String((cause as { stderr: unknown }).stderr)
        : String(cause);
    throw new NpmInstallError(
      "npm install failed while staging the installation.",
      stderr,
    );
  }
}

/**
 * Whether the npm CLI is present.
 *
 * Checked at boot rather than at the first install, because the answer is a
 * property of the image and an operator who learns it only when a board tries
 * to install something learns it at the worst possible moment. Slim and
 * distroless bases do not always carry npm.
 */
export async function npmAvailable(npmPath = "npm"): Promise<boolean> {
  try {
    await run(npmPath, ["--version"], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
