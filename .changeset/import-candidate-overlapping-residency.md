---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

When a row of a member list import could be more than one person, the preview
now says which of them already has a residency on the apartment that overlaps
the row's in another role or for other dates. Choosing that person writes
nothing for the row and counts it as a problem, and the screen now says so
beside the choice instead of only in the result after the import.
