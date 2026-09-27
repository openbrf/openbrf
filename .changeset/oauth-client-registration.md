---
"@openbrf/api": patch
---

Register an OAuth client only through the administrator's route.

The sign-in library's own client-management endpoints accepted any signed-in
account. A resident could register a client under any name and host, the
association's own included, send its authorization codes to an address of their
choosing, and change either later. A member who consented to that client on the
consent screen gave its registrant a token acting as them. Those endpoints now
answer 404, and the library refuses every client action to anybody without
`association:manage`, however it is called. A client is registered by hand
through `POST /api/oauth-clients`, which requires `association:manage` and
records the registration in the audit log.

That route answered 500 for an administrator, because it called the library
without the administrator's session. It now registers the client, links it to
the resource and records it.

The authorization server no longer offers the `client_credentials` grant, so
every token it issues acts for a person who consented to it.
