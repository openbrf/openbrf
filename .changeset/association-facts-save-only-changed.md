---
"@openbrf/web": patch
---

Saving the association facts could clear every fact on the broker page: the
form was savable before the stored facts had been read, or after the read
failed, and each save sent every field, so the empty ones were cleared. A read
that arrived after the board had started typing was also thrown away.

The save button now waits until the stored facts have been read, a save sends
only the fields the board changed, and a late read fills in the fields nobody
has typed in while keeping what was typed.
