---
"@openbrf/api": patch
"@openbrf/shared": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Judge a ten-digit personal identity number's century by the whole birth date,
store it with that century, and reindex the people already stored.

A number written without its century takes the most recent birth date that is
not in the future. Only the year was compared, so in March 2026 `261201-1235`
was read as 1 December 2026, a date still to come, and a search for
`192612011235` did not find the person. The date is now compared whole, with a
coordination number's day taken without its offset of 60. A plus separator is
still read as the year the person turns 100.

Even read by the whole date, the same ten digits name another person once the
day they are read on passes the birthday they carry: `261201-1235` is 1926 until
1 December 2026 and 2026 from then on. So a number is now stored with the
century it was read with (`19261201-1235`), and one whose reading would differ
a year earlier or a year later is refused, by the person form and by the
import, until it is written with its century. A number accepted on two dates
less than a year apart is read as the same person on both, so a file previewed
today matches the same people when it is applied or imported again.

Each person now records the normalisation rules their blind indexes were
computed under. After the upgrade the instance recomputes the indexes of every
person stored before it, from the encrypted values, in a job queued at start,
and writes the century into each stored personal identity number that lacks
one. There is nothing to do by hand; until the job has finished, a search by
phone number or personal identity number can miss a person stored before the
upgrade.
