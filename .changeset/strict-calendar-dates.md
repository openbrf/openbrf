---
"@openbrf/api": patch
"@openbrf/shared": patch
---

Harden how the API reads a calendar date.

Every endpoint that takes a "YYYY-MM-DD" date now refuses one the calendar does
not have, such as the 30th of February or a 13th month, with a 400 rather than
reading it as a different day. Moves, lien notes and positions of trust also
refuse it in the service, and a member list import checks the move-in date
chosen for the whole file as it checks the date in a row.

A lien note cannot be dated or released on a day that has not arrived, and a
release cannot be dated before the note it releases.
