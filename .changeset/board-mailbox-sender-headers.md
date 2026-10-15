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

A From header that does not name exactly one sender is refused rather than
read for whichever address came last: a list of addresses, a second address
beside the first, or a comment left open after an address. The mailbox provider
may have checked the sender's domain against another address in it than the
one read here, so such a letter is set aside for having no sender address. A
parenthesis left open in a display name, such as `Kalle :-(`, is still read as
part of the name.

Characters a reader cannot see (C1 controls, the soft hyphen, bidirectional
controls, zero-width and word-joining characters, Hangul fillers, variation
selectors and tag characters) are removed from a letter's subject, its sender's
name and its attachments' names, and an address holding one is not accepted as
the sender's address.
