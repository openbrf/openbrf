---
"@openbrf/theme-tools": patch
---

Count every file record in a theme archive toward the 200-file limit, not only
distinct paths. An archive that repeated one path more than 200 times used to
pass the limit; it is now refused with the same message.
