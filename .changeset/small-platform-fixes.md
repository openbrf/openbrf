---
"@openbrf/api": patch
---

Listen on the validated `PORT`, so an empty value means the default rather than
a random port. Log only whether an SMTP sender or a board mailbox address is
set, not the address. Two processes generating the development encryption key
at once now agree on one key instead of the second overwriting the first.
