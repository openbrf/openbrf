import { defineConfig } from "vite-plus";

/*
 * Import boundaries. AGENTS.md says where each kind of code belongs; these
 * patterns refuse the imports that would put it somewhere else, and each
 * message names the place it goes instead.
 */
const BY_PACKAGE_NAME = {
  regex: String.raw`^(\.\./)+(apps|packages|e2e)/|^(\.\./)+[\w.-]+/src(/|$)`,
  message:
    "Import another workspace by its package name, through the entry points its package.json exports.",
};
const API_FROM_WEB = {
  group: ["@openbrf/api", "@openbrf/api/**"],
  message:
    "The web application reaches the API over HTTP. Mirror the contract in apps/web, or move what both need to packages/shared.",
};
const WEB_FROM_API = {
  group: ["@openbrf/web", "@openbrf/web/**"],
  message:
    "The API does not import the web application. Move what both need to packages/shared.",
};
const APPLICATIONS_FROM_PACKAGE = {
  group: ["@openbrf/api", "@openbrf/api/**", "@openbrf/web", "@openbrf/web/**"],
  message:
    "A package is imported by the applications, not the other way round. Move what the package needs into it.",
};
const PRIVATE_FROM_PUBLISHED = {
  group: [
    "@openbrf/shared",
    "@openbrf/shared/**",
    "@openbrf/i18n",
    "@openbrf/i18n/**",
  ],
  message:
    "A published package installs from npmjs.com, where the private packages do not exist. Move what it needs into the package.",
};
const CRYPTO_LIBRARIES = {
  group: [
    "ciphersweet-js",
    "ciphersweet-js/**",
    "sodium-native",
    "sodium-native/**",
  ],
  message:
    "Reached only through apps/api/src/crypto, so the library can be replaced without touching its callers (ADR 0002, ADR 0015).",
};

const boundaries = (patterns: object[]): ["error", { patterns: object[] }] => [
  "error",
  { patterns: [BY_PACKAGE_NAME, ...patterns] },
];

/**
 * The workspace's lint configuration, and nothing else (ADR 0025).
 *
 * `vp lint` reads the `lint` block from the root config only, so every package
 * is linted against these rules whether or not it has a vite.config.ts of its
 * own. Nothing builds or tests from this file: apps/web keeps its own config,
 * and the packages keep their vitest.config.mts.
 */
export default defineConfig({
  lint: {
    plugins: ["typescript", "react", "unicorn", "oxc"],
    jsPlugins: [
      "eslint-plugin-i18next",
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
    ],
    options: {
      typeAware: true,
    },
    categories: {
      correctness: "error",
    },
    rules: {
      "typescript/no-floating-promises": "error",
      "typescript/await-thenable": "error",
      "typescript/no-misused-promises": "error",
      "i18next/no-literal-string": "error",
      // Vite and Vitest are reached through vite-plus, which pins them.
      "vite-plus/prefer-vite-plus-imports": "error",
      "no-restricted-imports": boundaries([]),
    },
    // A later entry replaces an earlier one's rule for the files both match.
    overrides: [
      {
        files: ["apps/web/**"],
        rules: { "no-restricted-imports": boundaries([API_FROM_WEB]) },
      },
      {
        files: ["apps/api/**"],
        rules: {
          "no-restricted-imports": boundaries([WEB_FROM_API, CRYPTO_LIBRARIES]),
        },
      },
      {
        // The crypto module wraps the libraries, and a suite may arrange
        // ciphertext with them directly.
        files: [
          "apps/api/src/crypto/**",
          "apps/api/**/*.spec.ts",
          "apps/api/**/*.int-spec.ts",
        ],
        rules: { "no-restricted-imports": boundaries([WEB_FROM_API]) },
      },
      {
        files: ["packages/**"],
        rules: {
          "no-restricted-imports": boundaries([APPLICATIONS_FROM_PACKAGE]),
        },
      },
      {
        files: [
          "packages/plugin-sdk/**",
          "packages/theme-tools/**",
          "packages/tokens/**",
        ],
        rules: {
          "no-restricted-imports": boundaries([
            APPLICATIONS_FROM_PACKAGE,
            PRIVATE_FROM_PUBLISHED,
          ]),
        },
      },
    ],
    ignorePatterns: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/src/generated/**",
    ],
  },
});
