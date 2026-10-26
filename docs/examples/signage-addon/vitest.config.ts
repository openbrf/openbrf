import { defineConfig } from "vitest/config";

/**
 * The tests load the server bundle as it ships, so `pnpm test` builds first.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
