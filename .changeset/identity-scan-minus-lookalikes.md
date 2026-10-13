---
"@openbrf/shared": patch
"@openbrf/api": patch
---

Close two gaps left by the subletting follow-up.

The personal identity number scan now reads the characters that look like the minus
between the date and the last four as that sign: the modifier letter minus, the
hyphen bullet, the heavy minus sign, the box drawings horizontals and the
horizontal line extension. The scan did not recognize these look-alike signs, so
a number written with one passed it. The parser for stored values is unchanged.

Recording the end of a subletting answers "no such application" when the nightly
purge deleted the application between the read and the write, instead of 500.
