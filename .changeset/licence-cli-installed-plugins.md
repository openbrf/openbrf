---
"@openbrf/api": patch
---

`openbrf licence add` and `openbrf licence list` now count only plugins the
board has installed when they check a licence, as the server does: a package
left on the data volume without an install record no longer verifies a licence
or shows it active. `licence list` no longer prints a literal `\n` before each
plugin's line, and a licence issued to another instance shows
`[verified, issued to another instance]` instead of `[verified]`.
