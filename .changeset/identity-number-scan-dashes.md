---
"@openbrf/shared": patch
---

Find a personal identity number written with an en dash, an em dash, a minus
sign or another Unicode hyphen between the date and the last four digits, as a
word processor sets `811228 - 9874`. Only the scan of free text accepts them;
the parser a stored number goes through is unchanged, so no blind index moves.
