---
"@openbrf/api": patch
---

Keep the board's note on a publication consent out of the audit log, which
outlives every erasure. The entry now records only that a note was written. A
note carrying a personal identity number is refused with the reason
`personal-identity-number`.
