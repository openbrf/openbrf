---
"@openbrf/api": patch
---

The member list import refuses a mapping that maps a role or move-in date
column and also gives a role or move-in date for the whole file. The value for
the whole file is for a file without that column, and the screen only offers it
then. Through the API, a blank cell used to get it, and a row without a date
could then be counted as a residency already recorded or refused as a conflict
depending on the order of the rows.
