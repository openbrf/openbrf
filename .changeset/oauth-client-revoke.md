---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

An administrator can turn a connected app away for the whole instance with
`DELETE /api/oauth-clients/<client id>`, which needs `association:manage`. Every
member's connection to it is cut at once, its tokens stop working, its client
id is refused at authorization from then on, and the audit log records it as
`OAUTH_CLIENT_REVOKED`, with a `CONNECTED_APP_DISCONNECTED` entry against each
member whose connection it cut, so their own data subject access report shows
it. A client the instance does not know answers 404 with the reason
`client-not-found`.
