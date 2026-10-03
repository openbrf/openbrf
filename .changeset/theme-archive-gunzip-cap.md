---
"@openbrf/theme-tools": patch
---

Stop `readThemeArchive` from unzipping a theme package that inflates far past
the archive limits. The decompressor now stops at the most a package within
those limits can occupy and the reader refuses it with a `ThemeArchiveError`,
instead of holding a gzip bomb in memory until the size check runs.

To give that ceiling a bound, directory records now have a limit of their own:
an archive may hold at most 200 (`MAX_DIRECTORY_RECORDS`), alongside its 200
files, and one with more is refused. They used to be skipped without limit.
Directory records still do not count toward the file limit. Other packages
within the limits and packed the usual way (by `writeThemeArchive` or a
standard `tar`) read exactly as before.
