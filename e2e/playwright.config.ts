import { defineConfig, devices } from "@playwright/test";

import { stack } from "./src/stack";

/**
 * The end-to-end suite runs against the production stack, never a dev server.
 *
 * globalSetup builds the image from the repository and starts
 * docker-compose.prod.yml with the e2e overlay, from empty volumes. That is
 * deliberate and not merely thorough: several of the exit criteria are about
 * things only the deployed artefact does - the entrypoint provisioning the
 * field encryption key, the application connecting as a database role that
 * cannot rewrite the statutory registers, the API serving the built client from
 * one origin so the session cookie survives.
 *
 * Chromium only. A virtual WebAuthn authenticator is a Chrome DevTools Protocol
 * feature and exists in no other engine, so the passkey specs carry the
 * @webauthn tag: a browser project added later must set
 * `grepInvert: /@webauthn/` rather than being expected to pass them.
 */
export default defineConfig({
  testDir: "./specs",
  outputDir: "../test-results",

  // Serial, in file-name order. The first spec asserts on first-boot
  // behaviour, which an instance only offers once, and the specs after it share
  // one instance rather than each paying for a stack of their own.
  fullyParallel: false,
  workers: 1,

  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },

  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { outputFolder: "../playwright-report", open: "never" }],
      ]
    : [
        ["list"],
        ["html", { outputFolder: "../playwright-report", open: "never" }],
      ],

  globalSetup: "./src/global-setup.ts",
  globalTeardown: "./src/global-teardown.ts",

  use: {
    baseURL: stack.baseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
