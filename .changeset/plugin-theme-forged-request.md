---
"@openbrf/api": patch
---

Answer a plugin's theme install with 403 and `forbidden-capability` when the
request it passes is not one the platform authenticated, instead of a 500 with
no reason.
