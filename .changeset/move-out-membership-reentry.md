---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Say when a move-out's membership begins again on an apartment bought for later.

When a member moves out of their only apartment while one they have bought has
not been taken over yet, the member register records the gap: the membership
ends on the move-out date and begins again on the later move-in date. The
move-out answer now carries that date as `memberRegisterEntryOn`, and the
move-out panel says the membership begins again then, rather than only that it
was closed.
