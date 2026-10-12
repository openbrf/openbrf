---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Tell the board how to fix a CSV that mixes encodings.

A CSV without a byte order mark that is UTF-8 apart from a stray byte is
refused, but the board saw only "That file could not be read as a spreadsheet.",
which does not say what to do. The refusal now has its own reason,
`file-mixed-encoding`, and the import screen says to save the file again as
UTF-8 or as "CSV (semikolonavgränsad)" and upload it again.
