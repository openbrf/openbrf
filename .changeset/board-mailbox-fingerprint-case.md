---
"@openbrf/api": patch
---

Recognise the board's mailbox by its host and user name however they are
capitalised or spaced in the settings. Correcting `Mail.Example.se` to
`mail.example.se` no longer makes every letter still in the mailbox look new.
Letters already collected under a host or user name typed with capitals or
spaces are carried over on the first collection after the upgrade, so nothing is
collected twice.
