---
"@openbrf/web": patch
---

When somebody else took a slot first, the booking panel said the calendar had been read again but did not read it, so the lost slot still read as free. It now reads the calendar again after that refusal and after a slot that can no longer be booked. A refusal no longer stays on screen after the resource or the week changes, in the booking panel or in the board's calendar, where it could hide a failed read of the new one. A stay being put together now starts again when the window moves, because the check for a night somebody else holds sees only the nights on screen.
