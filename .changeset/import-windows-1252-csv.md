---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Read a member list saved by Swedish Excel without losing å, ä and ö.

Excel on Swedish Windows saves "CSV (semikolonavgränsad)" in Windows-1252, and
the import read every CSV as UTF-8, so each Swedish letter became U+FFFD and
the damaged names were written into the member register. The import now
decodes a CSV as strict UTF-8 and falls back to Windows-1252 when the bytes are
not UTF-8; a UTF-8 file with a byte order mark reads as before.

A value that still holds U+FFFD, because the file lost the letter before it got
here, is now a problem on its row in the preview: the row is not imported, and
the board sees why before applying.
