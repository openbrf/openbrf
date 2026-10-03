---
"@openbrf/shared": patch
---

A personal identity number written without its century is now dated by the
whole birth date on the association's calendar. Until now only the year was
compared, so on 29 September 2026 the number 261215-1239 was read as a person
born in December 2026 rather than one turning 100 that month, and it did not
match the same number written as 19261215-1239. The year was also read off the
server's own clock rather than the day in Stockholm. A number written with a
plus sign is dated by its year alone, because the plus is written from 1
January of the year the person turns 100.

A number written with its century is refused when the century is not 18, 19 or
20, or when the birth date lies in the future. A twelve-digit invoice or OCR
reference whose last ten digits happen to form a valid number is no longer
reported as a personal identity number, so it no longer stops the text it is in
from being published.
