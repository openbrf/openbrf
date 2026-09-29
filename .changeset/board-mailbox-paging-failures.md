---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

In the board mailbox, a failed read of older threads or of a thread's earlier messages was silent: the button went back to its label as if nothing more was there. Both now say that the read failed, and the next press tries again.

A thread that changed between two page reads of the inbox could be listed twice. It is now listed once.
