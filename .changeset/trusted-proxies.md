---
"@openbrf/api": minor
---

Add `TRUSTED_PROXIES`, the addresses or CIDR ranges of the reverse proxy in
front of an instance. The rate limits on the public forms now read
`X-Forwarded-For` only on a request from one of these, and from the right, past
the hops those proxies wrote, so only what the instance's own proxies wrote is
believed. The sign-in endpoints count the same address, so a request sent to
the application's port past the proxy is counted by where it came from rather
than by a header of its choosing. Left empty, the forms and the sign-in
endpoints count each request by the address it came from, so every visitor
behind an unnamed proxy shares one budget: set it when upgrading
(docs/deployment.md, "Behind a reverse proxy"). A range of every address, such
as `0.0.0.0/0` or `::/0`, is refused at start, since it would trust every client
to say where it came from.
