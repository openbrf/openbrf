import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * Integration tests run against a real PostgreSQL instance (docker compose up
 * db) because what they verify - database triggers, privileges and constraints
 * - has no meaning against a mock.
 *
 * Kept in a separate config so `pnpm test` stays fast and dependency-free,
 * while `pnpm test:int` is the suite that needs infrastructure.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.int-spec.ts"],
    // The statutory guards share tables, so parallel files would fight over
    // the same rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [
    swc.vite({
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
      module: { type: "es6" },
    }),
  ],
});
