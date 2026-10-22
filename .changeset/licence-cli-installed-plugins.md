---
"@openbrf/api": patch
---

A package left on the data volume without a record of the board's consent no
longer verifies a licence or shows it active, on the licence screen or from
`openbrf licence add` and `openbrf licence list`; the plugin screen still
reports it. From those two commands, a package other than the one the board
consented to, by name, version or install directory, no longer counts either,
as on the screen already. `licence list` no longer prints a literal `\n` before
each plugin's line, and a licence issued to another instance shows
`[verified, issued to another instance]` instead of `[verified]`.
