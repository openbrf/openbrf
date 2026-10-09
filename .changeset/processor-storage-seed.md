---
"@openbrf/api": patch
---

Classify storage on the association's own disk in the processor register
without asking the board.

An instance storing files on its own disk has no processor for storage, and the
register already suggested so, yet it still listed storage as a recipient the
board had not classified. The instance now records it as no processor when it
starts, once setup has completed. When the storage driver moves to a bucket,
that row is closed with the reason `driver-changed` and the board is asked
again. A classification the board recorded itself is never closed or replaced,
whichever driver the instance uses.

Both the recording and the closing appear in the audit log as the system's own
acts, with no person behind them.
