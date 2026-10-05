---
"@openbrf/api": patch
---

Refuse to start in production with a `BETTER_AUTH_SECRET` shorter than 32
characters or equal to the development placeholder, and say how to generate
one. `.env.production.example` now says the same.
