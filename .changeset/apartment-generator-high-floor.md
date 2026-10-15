---
"@openbrf/web": patch
---

Generating apartment numbers from a high lowest floor with more floors than fit above it, such as floor 85 and 90 floors, did nothing and said nothing. It now generates the floors that fit.
