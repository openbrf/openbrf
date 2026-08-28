import { defineConfig, devices } from "@playwright/test";

import { stack } from "./src/stack";

/**
 * The screenshot task: `pnpm screenshots` from the repository root.
 *
 * CONTRIBUTING.md requires light and dark images in the pull request
 * description for UI work. This produces them against the production stack -
 * the same image, entrypoint and constrained database role the end-to-end suite
 * uses - so what a reviewer looks at is the screen an association gets, not a
 * dev server's approximation of it.
 *
 * A configuration of its own rather than a project inside playwright.config.ts,
 * because the two runs want opposite things. The suite wants many small
 * independent specs and screenshots only when something fails; this wants one
 * long ordered walk that always photographs. It also drives a stack of its own:
 * see the profile note in src/stack.ts.
 */

export default defineConfig({
  testDir: "./screenshots",
  outputDir: "../test-results",

  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // A rerun of a capture should produce the images again, not a retry's worth
  // of half-walked state.
  retries: 0,
  timeout: 25 * 60_000,
  expect: { timeout: 15_000 },

  reporter: [["list"]],

  globalSetup: "./src/global-setup.ts",
  globalTeardown: "./src/global-teardown.ts",

  use: {
    baseURL: stack.baseUrl,
    // Playwright leaves actions unbounded by default, so a declared target that
    // matches nothing would wait out the whole test rather than saying which
    // entry is wrong. A capture is a walk with many steps, and the step that
    // failed is the thing worth knowing.
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    // The capture writes its own images; Playwright's failure screenshots would
    // land among them.
    screenshot: "off",
    video: "off",
  },

  // The viewport, the pixel density and the viewer's motion setting are chosen
  // by the capture itself: the suite's `context` fixture builds its browser
  // context by hand, so anything set here would be dropped on the way.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
