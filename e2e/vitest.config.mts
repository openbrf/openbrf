import { defineConfig } from "vitest/config";

// The suite's own helpers, tested without a stack. Named *.test.ts, so neither
// these nor Playwright's *.spec.ts files under specs/ are taken for the other.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
