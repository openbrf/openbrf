---
"@openbrf/api": patch
---

A client registered by hand is removed again when linking it to the resource or
recording its registration fails, so a failed registration leaves no live client
without an audit entry behind, and a retry does not create a second one.
