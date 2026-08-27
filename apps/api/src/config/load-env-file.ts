import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/**
 * Loads the nearest .env at or above a directory, if one exists.
 *
 * Used by the API, the integration tests and the CLI scripts so none of them
 * depend on variables being exported by hand. In a container no file is
 * present and the environment is authoritative.
 *
 * The search walks upward rather than resolving against this file's own
 * location, because the API is CommonJS in production and ESM under Vitest, and
 * neither __dirname nor import.meta.dirname exists in both.
 */
export function loadNearestEnvFile(
  startDirectory: string = process.cwd(),
): void {
  const { root } = parse(startDirectory);
  let directory = startDirectory;

  for (;;) {
    const candidate = join(directory, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    if (directory === root) {
      return;
    }
    directory = dirname(directory);
  }
}
