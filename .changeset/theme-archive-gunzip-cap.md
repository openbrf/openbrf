---
"@openbrf/theme-tools": patch
---

Stop `readThemeArchive` from unzipping a theme package that inflates far past
the archive limits. The decompressor now stops at the most a package within
those limits can occupy and the reader refuses it with a `ThemeArchiveError`,
instead of holding a gzip bomb in memory until the size check runs. Packages
within the existing limits read exactly as before.
