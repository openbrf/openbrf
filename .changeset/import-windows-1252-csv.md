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
not UTF-8. A file with a UTF-8 byte order mark is always read as UTF-8, so a
single stray byte in it costs one letter rather than turning the whole file
into mojibake. A file without one that is UTF-8 apart from a stray byte is
refused as unreadable, rather than read as Windows-1252 and imported as
mojibake such as "Ã…sa"; saving it again as UTF-8 or as Excel's
"CSV (semikolonavgränsad)" fixes it.

A value that still holds U+FFFD, because the file lost the letter before it got
here, is now a problem on its row in the preview: the row is not imported, and
the board sees why before applying.
