---
"@openbrf/api": patch
---

Read the board mailbox's letters as their senders wrote them.

A subject or a name sent as raw UTF-8 is no longer shown as "FrÃ¥ga". The
sender's address is the one after the display name even when the name itself
carries angle brackets, so such a letter is no longer set aside for having no
sender address. An attachment whose name arrives in numbered RFC 2231 segments
keeps that name rather than being called "bilaga-1".

Characters a reader cannot see (C1 controls, bidirectional controls and
zero-width characters) are removed from a letter's subject and its sender's
name, and an address holding one is not accepted as the sender's address.
