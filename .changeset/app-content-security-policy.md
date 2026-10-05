---
"@openbrf/api": patch
---

Serve the application under `/app` with a Content-Security-Policy: scripts and
everything else only from the instance's own origin, inline style for the theme,
and no framing by any site. The public website's policy now also names
`frame-ancestors 'self'`.
