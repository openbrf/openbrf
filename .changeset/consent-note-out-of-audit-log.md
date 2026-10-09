---
"@openbrf/api": patch
"@openbrf/shared": patch
---

Keep the board's note on a publication consent out of the audit log, which
outlives every erasure. The entry now records only that a note was written. A
note carrying a personal identity number is refused with the reason
`personal-identity-number`, however it is written: soft hyphens, zero-width
characters and fullwidth digits no longer hide one. A note sent with a
withdrawal is refused rather than accepted and dropped. Consent notes in audit
entries written before this change stay where they are.

Every personal identity number check now also sees a number hidden with an
invisible character (a byte order mark, a word joiner, a variation selector) or
written in fullwidth digits, and a line break or tab inside free text is no
longer removed before the check. A number written with spaces or a line break
between its date and its last four digits (`811228 - 9874`, `811228 9874`) is
found too, as the identity-number parser already read it. The note is stored as
it was checked, with the invisible characters removed and fullwidth forms
folded.
