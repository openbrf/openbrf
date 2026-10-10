---
"@openbrf/api": patch
---

Harden the board mailbox's sign-in.

The mailbox host, user name and password are refused when they contain a line
break or another control character, both in the settings and again before
anything is sent to the mailbox. A mailbox that answers the sign-in with
`[IN-USE]` (another mail client holds it) or `[SYS/...]` (a fault on its side)
is now reported as unreachable rather than as a wrong password, so the board is
not sent to change a password that is right.
