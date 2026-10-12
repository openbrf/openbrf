---
"@openbrf/api": patch
---

Refuse a form-encoded (`application/x-www-form-urlencoded`) body on `/api/*`
with 415. Every client of the API sends JSON, or multipart for an upload. The
sign-in paths under `/api/auth`, where the OAuth token endpoint is form-encoded,
and the public site's contact and fault report forms keep accepting it.
