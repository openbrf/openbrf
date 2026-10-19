import { defineConfig } from "vite-plus";

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
    },
    overrides: [
      {
        // apps/api/src/testing is left out of the production build by its
        // tsconfig exclude, which an import from production code would quietly
        // undo: tsc compiles whatever a compiled file imports. The stand-in for
        // Lantmäteriet lives there, and reachable from a running instance it
        // could discharge a statutory duty on nothing (ADR 0029).
        files: ["apps/api/src/**"],
        excludeFiles: [
          "apps/api/src/**/*.spec.ts",
          "apps/api/src/**/*.int-spec.ts",
          "apps/api/src/testing/**",
        ],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  regex: "^\\.{1,2}/(?:.*/)?testing(?:/|$)",
                  message:
                    "src/testing is for tests only and is not in the production build.",
                },
              ],
            },
          ],
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
