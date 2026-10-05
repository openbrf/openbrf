---
"@openbrf/api": minor
---

Add `TRUSTED_PROXIES`, the addresses or CIDR ranges of the reverse proxy in
front of an instance. The rate limits on the public forms now read
`X-Forwarded-For` only on a request from one of these, and from the right, past
the hops those proxies wrote, so only what the instance's own proxies wrote is
believed. Better Auth's sign-in limiter is given the same list. Left empty, the forms count each request by the address it came from, so
every visitor behind an unnamed proxy shares one budget: set it when upgrading
(docs/deployment.md, "Behind a reverse proxy").
