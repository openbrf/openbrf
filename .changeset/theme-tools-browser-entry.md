---
"@openbrf/theme-tools": patch
---

Give the package a browser entry. A bundler that resolves the `browser` export
condition, as Vite does for the browser, now loads everything except the
archive reader and writer and the package lint built on them
(`readThemeArchive`, `writeThemeArchive`, `ThemeArchiveError`, the archive
limits, `readThemePackage`, `lintThemePackage` and `lintThemeAgainst`). Those
unpack with `node:zlib`, and importing them in a browser broke the module
graph: under the Vite development server the page stayed blank. Node, and
anything else that does not resolve the `browser` condition, gets the full
package as before.
