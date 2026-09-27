---
"@openbrf/plugin-sdk": minor
"@openbrf/theme-tools": minor
"@openbrf/tokens": minor
---

Publish the plugin SDK, the theme tools and the design tokens publicly on
npmjs.com, with a provenance attestation. A plugin or theme author outside the
organization can now install the contract they write against, and run the same
checks in their own CI (`pluginPackageProblems`, `lintThemePackage`) that the
core runs at install time. Each package carries the AGPL and the Open BRF
Module Exception, which is what lets a module be licensed on its author's own
terms.
