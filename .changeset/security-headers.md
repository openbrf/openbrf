---
"@openbrf/api": patch
---

Send `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff` and
`Referrer-Policy: same-origin` on every response whose route did not set its
own, and `Strict-Transport-Security` in production over https, so the
application's pages and answers cannot be framed by another site.
