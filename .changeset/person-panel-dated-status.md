---
"@openbrf/web": patch
---

The person panel in the register read a residency with a move-out date still to
come as ended, dropped the board sign of a sitting member whose term has a
future end date, and showed the sign for a seat elected from a future date. The
panel now reads those dates against today on the association's calendar, the
way the rest of the register does.
