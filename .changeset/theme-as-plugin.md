---
"@openbrf/theme-tools": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Install themes as data-only plugins, with inheritance.

A theme is a manifest, token values for both modes, bundled font files with
their licences, an optional logo and a choice among the core's own view
variants. It carries no code, so installing or switching one writes files and a
row and needs no restart.

The install path reads a catalog entry, verifies the package against the sha512
the catalog states, reads the archive and runs the theme lint before anything is
written. The lint is a gate: it refuses a theme that renders the statutory
register below WCAG AA in either mode, one carrying anything executable, and one
whose fonts are not bundled and licensed. A theme declares `extends` and states
only what it changes; the default theme is built in, always inheritable and
cannot be removed. An administrator previews an installed theme in their own
browser session before activating it.

`@openbrf/theme-tools` holds the manifest schema, the lint, `extends`
resolution, the view-variant registry and the archive reader, so a theme
repository's CI can run the same check the core runs at install time.
