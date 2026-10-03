---
"@openbrf/web": patch
---

Acting on a motion further down the board's queue no longer collapses the queue
to its first page. The queue is read again as far down as the board had read,
so the motion just handled stays in view.
