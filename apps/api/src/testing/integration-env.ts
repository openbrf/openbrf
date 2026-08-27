import { loadNearestEnvFile } from "../config/load-env-file";
import { type Env, loadEnv } from "../config/env";

/**
 * Loads the environment for integration tests, which need a real database.
 *
 * Fails with an actionable message rather than a stack trace when the
 * environment is not configured, because "copy .env.example" is the fix and a
 * Zod issue list does not say so. Note that this only validates configuration:
 * a database that is down still surfaces later, as a connection error.
 *
 * NODE_ENV is set on process.env rather than only in the copy handed to
 * loadEnv, because things outside this Env read it directly - JobQueueService
 * decides whether to start the queue from it. Leaving that to each suite means
 * one that forgets boots its modules in the wrong mode.
 */
export function loadEnvForIntegrationTests(): Env {
  loadNearestEnvFile();
  process.env.NODE_ENV = "test";

  try {
    return loadEnv(process.env);
  } catch (cause) {
    throw new Error(
      "Integration tests need a configured environment. Copy .env.example to " +
        ".env and start the database with `docker compose up -d db`.",
      { cause },
    );
  }
}
