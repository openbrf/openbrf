---
"@openbrf/web": patch
---

A booking or cancellation that settles after the reader has moved to another
resource or period no longer puts its confirmation or refusal on the new view,
and no longer lets a second one start under it. The write still goes through and
the screen still reads again; only the notice stays with the view it was for.
