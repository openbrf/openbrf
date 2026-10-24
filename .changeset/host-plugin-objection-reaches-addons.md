---
"@openbrf/api": minor
---

An objection to a host plugin's processing now reaches its addons (ADR 0035).
While an addon answers one of the host plugin's extension points, its reads
through `host.addressBook` leave out every person whose objection to the host
plugin's processing the board granted, as well as those who objected to the
addon's own. Outside such a call the addon reads as before.
