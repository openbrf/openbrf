---
"@openbrf/theme-tools": patch
---

Refuse theme archives whose tar headers other tools read differently.

A name or prefix with a leading byte order mark is no longer stripped to
look like the plain name, and a field that is not UTF-8 is refused. A name or
prefix with anything but NULs after its first NUL is refused too.

Size, checksum, mode, uid, gid, mtime, devmajor and devminor must be leading
spaces, octal digits, then only spaces and NULs. A NUL before the digits is
refused, and so is anything else (a tab, a non-breaking space), which makes
size and the checksum stricter than before. GNU tar and bsdtar write a uid, gid
or mtime that does not fit octal (a uid above 2^21, a negative mtime) in
base-256: those fields (not used) are accepted when they start with 0x80 or
0xff, while a base-256 size or checksum is refused.

A `.` path segment left after the common root is stripped is refused, so
`theme.json` and `./theme.json` cannot be two entries for one file. Archives
made with `tar -czf x.tgz -C dir .` still read.
