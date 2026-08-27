import { loadNearestEnvFile } from "../config/load-env-file";
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
