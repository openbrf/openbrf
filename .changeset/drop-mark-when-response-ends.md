---
"@openbrf/api": patch
---

A plugin that keeps the request its route received can no longer dispatch an
action on it after the response has ended. Core drops the request's
authentication mark when the response is sent or the client leaves, including a
client that leaves after sending its request body, and a client that leaves
while core is still authenticating the request is not marked afterwards. A
dispatch on a kept request is refused instead of running as the person who made
it. Hardening only: capabilities were already checked at call time.
