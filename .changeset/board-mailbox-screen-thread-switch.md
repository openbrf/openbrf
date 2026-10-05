---
"@openbrf/web": patch
---

Open a thread in the board mailbox without losing the inbox pages already read,
and start each thread with an empty reply box.

Opening a thread no longer reads the inbox again from the start, so a thread
opened from a page read with "Visa äldre trådar" stays listed. A reply half
written for one thread, and the outcome of the last act on it, no longer stay on
screen when another thread is opened.
