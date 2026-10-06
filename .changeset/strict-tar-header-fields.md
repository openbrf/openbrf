---
"@openbrf/theme-tools": patch
---

Refuse a theme package whose tar headers tools read differently.

Every numeric header field (mode, uid, gid, size, mtime, checksum and the
device numbers) must now be plain ASCII octal, ended by NUL or space. A header
with a stray byte or a no-break space used to be read here while Python's
tarfile ended its listing at it, so a reviewer using it would not see the files
after it. GNU base-256 values, signs, bytes after the NUL and tabs are also
refused now: Python's tarfile reads them, but a theme package never needs them.
Names and path prefixes are decoded as strict UTF-8: an invalid byte used to
become U+FFFD, which let two different names collapse into one path. A name
that starts with a byte order mark keeps it.
