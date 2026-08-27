import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import { type Env, loadEnv } from "../config/env";

/**
 * Loads the environment for integration tests, which need a real database.
 *
 * Fails with an actionable message rather than a connection timeout when the
 * database is not running, because "docker compose up db" is the fix and a
 * stack trace does not say so.
 */
export function loadEnvForIntegrationTests(): Env {
  loadNearestEnvFile();

  try {
    return loadEnv({ ...process.env, NODE_ENV: "test" });
  } catch (cause) {
    throw new Error(
      "Integration tests need a configured environment. Copy .env.example to " +
        ".env and start the database with `docker compose up -d db`.",
      { cause },
    );
  }
}

function loadNearestEnvFile(startDirectory: string = process.cwd()): void {
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
