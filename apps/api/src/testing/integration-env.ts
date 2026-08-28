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
 * DATABASE_URL is required here even though the schema leaves it optional. A
 * production server runs without it - the entrypoint drops the owner's
 * credentials before it starts - but these suites create and delete the rows
 * they assert on, which is the owner's work and not the application role's.
 *
 * NODE_ENV is set on process.env rather than only in the copy handed to
 * loadEnv, because things outside this Env read it directly - JobQueueService
 * decides whether to start the queue from it. Leaving that to each suite means
 * one that forgets boots its modules in the wrong mode.
 */
export function loadEnvForIntegrationTests(): Env & { DATABASE_URL: string } {
  loadNearestEnvFile();
  process.env.NODE_ENV = "test";

  let env: Env;
  try {
    env = loadEnv(process.env);
  } catch (cause) {
    throw new Error(
      "Integration tests need a configured environment. Copy .env.example to " +
        ".env and start the database with `docker compose up -d db`.",
      { cause },
    );
  }

  if (env.DATABASE_URL === undefined) {
    throw new Error(
      "Integration tests connect as the schema owner, so DATABASE_URL has to " +
        "be set. Copy .env.example to .env.",
    );
  }
  return { ...env, DATABASE_URL: env.DATABASE_URL };
}
