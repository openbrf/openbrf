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
