---
"@openbrf/api": patch
---

The audit entry for a change made through a connected app now carries the app's
name beside its client id and host. Until now an app registered by an
administrator without a client URI left the host empty, and a reader of the log
could not tell which app acted without looking the client up. The name is read
from the client's own record when the entry is written, never from the request,
and is bounded to 100 characters. It is empty when the client has no name.
