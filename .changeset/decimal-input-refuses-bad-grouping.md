---
"@openbrf/web": patch
---

An amount typed with spaces in the wrong places, such as "12 34", is no longer
read as 1234. Spaces are taken out only where they group the whole part in
threes, as the formatter prints it; anything else is sent as typed and refused,
so a lien amount or share capital cannot be recorded as a figure nobody typed.
