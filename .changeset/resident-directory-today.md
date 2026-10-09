---
"@openbrf/api": patch
"@openbrf/web": patch
---

Show residents only who lives here today in the resident directory.

Any resident could list every former household with its move-out date, a
buyer before their move-in, and the administrator, the property manager and
anybody not yet placed. The resident directory now keeps residencies held today
and, of the people with no residency held today, those who hold a board seat
today, including a board member who has moved out. A resident's row carries no
move-out date and no "moved out" sign. The web no longer offers the "Moved out"
tab to residents. A person under a restriction of processing is also
left out by the directory's second check, as the query already did.
