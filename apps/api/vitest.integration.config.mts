import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

import { INTEGRATION_WORKER_COUNT } from "./src/testing/integration-database.ts";

/**
 * Integration tests run against a real PostgreSQL instance (docker compose up
 * db) because what they verify - database triggers, privileges and constraints
 * - has no meaning against a mock.
 *
 * Kept in a separate config so `pnpm test` stays fast and dependency-free,
 * while `pnpm test:int` is the suite that needs infrastructure.
 *
 * The suites share tables, so they cannot share a database. Each worker gets
 * one of its own instead: the global setup clones a migrated template once per
 * worker, and the setup file points the worker at its clone. See
 * src/testing/integration-database.ts.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.int-spec.ts"],
    globalSetup: ["./src/testing/integration-global-setup.ts"],
    setupFiles: ["./src/testing/integration-worker-database.ts"],
    // No more workers than the global setup provisioned databases for: a
    // worker beyond that count would be pointed at one that does not exist.
    maxWorkers: INTEGRATION_WORKER_COUNT,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [
    swc.vite({
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", tsx: true, decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
      module: { type: "es6" },
    }),
  ],
});
