---
"@openbrf/shared": patch
"@openbrf/api": patch
"@openbrf/web": patch
---

The issue report's place and description limits (200 and 4000 characters) are
now one definition in `@openbrf/shared`, used by both the API and the report
form, so the form and the server cannot drift apart.
