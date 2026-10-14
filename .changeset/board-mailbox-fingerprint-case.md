---
"@openbrf/api": patch
---

Recognise the board's mailbox by its host however it is capitalised or spaced in
the settings. Correcting `Mail.Example.se` to `mail.example.se` no longer makes
every letter still in the mailbox look new. Letters already collected under a
host typed with capitals or spaces are carried over on the first collection
after the upgrade, so nothing is collected twice. The user name is taken exactly
as it is sent to the mail server, which decides what it means: two mailboxes on
one server whose user names differ only in case stay two mailboxes.
