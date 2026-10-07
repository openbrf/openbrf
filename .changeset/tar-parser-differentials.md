---
"@openbrf/theme-tools": patch
---

Refuse theme archives that `tar` and Python's tarfile would list differently
from the installer: a header after a lone zero block, a directory entry that
states a size, and a path prefix in a header without the ustar magic. Archives
written by `writeThemeArchive`, `npm pack`, GNU tar and bsdtar read as before.
