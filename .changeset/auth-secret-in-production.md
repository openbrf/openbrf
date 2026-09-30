---
"@openbrf/api": patch
---

Refuse to start in production with a `BETTER_AUTH_SECRET` shorter than 32
characters or equal to the development placeholder, and say how to generate
one. `.env.production.example` now says the same.

**Upgrade note:** a production deploy whose secret is shorter than 32
characters, or is the placeholder, stops booting after this release until the
secret is replaced. Generate one (`openssl rand -base64 48`) and set it before
updating. Every session and sign-in link is signed with it, so changing it
signs everybody out.
