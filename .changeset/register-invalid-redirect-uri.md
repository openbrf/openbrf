---
"@openbrf/api": patch
---

Answer `invalid-redirect-uri` when registering a connected app by hand with an
address the instance refuses (this machine over https, a loopback host written
some other way, or an address with a user name or a fragment). It answered
`invalid-body` before, so the form could not say which address was the problem.
A malformed body still answers `invalid-body`.
