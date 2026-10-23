---
"@openbrf/api": patch
---

The sign-in library's new endpoint for replacing a connected app's signing keys,
`/oauth2/client/rotate-keys`, answers 404 over HTTP, like the other endpoints
that manage a connected app. Registering a connected app stays an
administrator's act through `POST /api/oauth-clients`.
