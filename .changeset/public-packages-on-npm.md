---
"@openbrf/plugin-sdk": major
"@openbrf/theme-tools": major
"@openbrf/tokens": major
---

Publish the plugin SDK, the theme tools and the design tokens publicly on
npmjs.com, with a provenance attestation. A plugin or theme author outside the
organization can now install the contract they write against, and run in their
own CI the same package checks the core runs at install time. Each package
carries the AGPL and the Open BRF Module Exception, which is what lets a module
be licensed on its author's own terms.

The first release is 1.0.0 for all three. The plugin SDK's major version is the
plugin API version, and the theme tools' and the tokens' major version is the
token contract's, so a major tells an author which hosts a package works with.
