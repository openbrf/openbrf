import { loadNearestEnvFile } from "../config/load-env-file";
import {
  redirectToWorker,
  withDatabase,
  workerDatabaseName,
} from "./integration-database";

/**
 * Points this worker at the database provisioned for it.
 *
 * Runs in every worker before any suite is imported, so the redirection is in
 * place by the time anything reads the environment - whether that is a suite
 * calling loadEnvForIntegrationTests or a Nest application building its own
 * ConfigModule, which reads process.env directly and would otherwise open the
 * database the developer works in.
 *
 * The override survives the .env being loaded again later: process.loadEnvFile
 * leaves a variable that is already set alone, which is what makes this the one
 * place the decision is made.
 */

/**
 * Where the original connection string is kept.
 *
 * Vitest runs the setup files once per test file and reuses the worker process
 * between them, so this module is evaluated many times against a process.env it
 * has already rewritten. Deriving the worker's database from DATABASE_URL a
 * second time would name it after the first rewrite - openbrf_test_1_test_1 -
 * so the untouched string is kept aside and every derivation starts there.
 */
const BASE_URL_VARIABLE = "OPENBRF_TEST_BASE_DATABASE_URL";

loadNearestEnvFile();

const baseUrl = process.env[BASE_URL_VARIABLE] ?? process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === "") {
  throw new Error(
    "Integration tests need DATABASE_URL to be set. Copy .env.example to .env.",
  );
}
process.env[BASE_URL_VARIABLE] = baseUrl;

// VITEST_POOL_ID is 1-based and never exceeds maxWorkers, which is the count
// the global setup provisioned for.
const poolId = Number(process.env.VITEST_POOL_ID ?? "1");
const workerUrl = withDatabase(baseUrl, workerDatabaseName(baseUrl, poolId));

process.env.DATABASE_URL = workerUrl;
// Set only where a run deliberately exercises the non-owner role. It names the
// same cluster, so it follows the same redirection; left alone when absent or
// empty, so the application keeps connecting as the owner it does locally.
const runtimeUrl = redirectToWorker(
  process.env.DATABASE_URL_RUNTIME,
  baseUrl,
  poolId,
);
if (runtimeUrl !== undefined) {
  process.env.DATABASE_URL_RUNTIME = runtimeUrl;
}
