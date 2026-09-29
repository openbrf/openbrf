---
"@openbrf/api": patch
---

Let a host allow an SMTP relay without STARTTLS on a network it trusts.

The relay set in the environment has to upgrade through STARTTLS before the
instance signs in, unless it is on loopback. A Postfix sidecar on the Compose
network (`OPENBRF_SMTP_HOST=postfix`) that offers no STARTTLS passed the check at
start and then failed every send. `OPENBRF_SMTP_REQUIRE_TLS=false` now allows it,
and the instance logs a warning at start while it is set. Unset, nothing changes:
a relay off loopback still gets no sign-in in the clear. `true` requires STARTTLS
from a relay on loopback too.
