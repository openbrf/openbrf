---
"@openbrf/theme-tools": patch
---

Refuse theme archives whose tar headers other tools read differently.

A name or prefix with a leading byte order mark is no longer stripped to
look like the plain name, and a field that is not UTF-8 is refused. Mode, uid,
gid, mtime, devmajor and devminor are checked as strictly as size: only octal
digits, with spaces and NULs around them, are accepted.
