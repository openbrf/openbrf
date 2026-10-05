---
"@openbrf/api": patch
"@openbrf/shared": patch
---

Judge a ten-digit personal identity number's century by the whole birth date,
and reindex the people already stored.

A number written without its century takes the most recent birth date that is
not in the future. Only the year was compared, so in March 2026 `261201-1234`
was read as 1 December 2026, a date still to come, and a search for
`192612011234` did not find the person; once that day had passed, the same
input was read the other way. The date is now compared whole, with a
coordination number's day taken without its offset of 60. A plus separator is
still read as the year the person turns 100.

Each person now records the normalisation rules their blind indexes were
computed under. After the upgrade the instance recomputes the indexes of every
person stored before it, from the encrypted values, in a job queued at start.
There is nothing to do by hand; until the job has finished, a search by phone
number or identity number can miss a person stored before the upgrade.
