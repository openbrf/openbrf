---
"@openbrf/api": patch
---

Answer a plugin's theme install with 403 and `forbidden-capability` when the
request it passes is not one the platform authenticated, instead of a 500 with
no reason.
A request the platform authenticated but has since answered, because the
plugin kept it past its response, keeps its own error and is not reported as a
refusal.
