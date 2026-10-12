---
"@openbrf/api": patch
---

Count a board mailbox thread as kept, rather than owed, when a granted erasure
reaches it and its address belongs to somebody under a legal hold or a
restriction. This happens when an address changes hands or a household shares
one. The purge already kept the thread, but the request's scan picked it ahead
of the nightly bound every night and the purge refused it every night. The open
request said the job had not got through yet, and kept saying so for as long as
the hold stood. The scan now leaves such a thread out. The request stays open
and names the thread as kept because of the hold.
