---
"@openbrf/theme-tools": patch
---

A theme archive whose header checksum matches only the signed byte sum is now
refused.

node-tar computes only the unsigned sum, so with a byte of 0x80 or more in a
header it skipped that header and read its data as headers, listing different
files than the theme tools did. Archives from the theme tools, `npm pack`, GNU
tar and bsdtar carry the unsigned sum and still read.
