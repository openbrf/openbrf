import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    // Not the association's zone, so a function that reads the process time
    // zone where it should read Stockholm's (ADR 0013) fails here rather than
    // passing on a developer's machine in Sweden.
    env: { TZ: "UTC" },
  },
});
