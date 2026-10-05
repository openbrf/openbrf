---
"@openbrf/api": patch
---

Keep a board mailbox thread's state consistent when two board members act on it
at once. Taking, releasing, answering and closing a thread, and a follow-up
reopening it, now wait for each other rather than one overwriting the other, so a
reply sent as somebody closes the thread no longer leaves it answered and closed
at once.
