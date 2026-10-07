---
"@openbrf/api": patch
---

Read the board mailbox's letters as their senders wrote them.

A subject or a name sent as raw UTF-8 is no longer shown with each non-ASCII
letter garbled into two others. The sender's address is the one after the
display name even when the name itself carries angle brackets, so such a letter
is no longer set aside for having no sender address, and an address in a
comment after it, such as a forwarder's, is not taken for the sender's. An
attachment whose name arrives in numbered RFC 2231 segments keeps that name
rather than the numbered placeholder given to an attachment that has none, and
a stray segment with no first one no longer replaces the plain name sent beside
it.

Characters a reader cannot see (C1 controls, the soft hyphen, bidirectional
controls, and zero-width and word-joining characters) are removed from a
letter's subject and its sender's name, and an address holding one is not
accepted as the sender's address.
