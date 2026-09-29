---
"@openbrf/api": patch
---

Keep a board mailbox thread's retention clock at its newest message when a
reply dated earlier arrives.

A thread is kept for two years from the last message on it. When a reply joined
a thread, the collector set that date to the reply's own Date header, whatever
it said. The header is the sender's clock, so a reply dated long before the
rest of the conversation - a client with a wrong clock, a letter held up
somewhere, an answer to an old copy - moved a live thread's clock back to that
day. A reply dated 700 days ago put a conversation from last week into the
purge a month later, and the whole thread was erased while it was still going
on.

A reply now moves the thread's clock forward only, never back. The comparison is
made in the database update itself, so two replies collected at the same moment
cannot leave the older date on the thread.
