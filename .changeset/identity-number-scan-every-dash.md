---
"@openbrf/shared": patch
"@openbrf/api": patch
"@openbrf/web": patch
---

Find a personal identity number written with any dash.

The scan that keeps an identity number off a page, a news item, a motion or a
subletting application took the hyphen and a list of look-alike dashes as the
sign before the last four digits. A number written with a dash missing from the
list, such as the horizontal bar (`811228―9874`), the two-em dash or the
Armenian hyphen, went through. NFKC does not fold those. The scan now takes
every character Unicode classes as a dash, plus the minus sign, and still runs
in linear time. The parser for a stored number is unchanged.

The import's check for number-shaped values now uses the same Unicode rules.
It used to read `\p{…}` as literal letters, so a value such as `811228p9874`
counted as number-shaped, and a value split by a non-breaking space did not.
