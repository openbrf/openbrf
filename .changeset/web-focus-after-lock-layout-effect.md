---
"@openbrf/web": patch
---

Give a form its focus back in the same render that unlocks it.

A form that is locked while it saves hands focus back to the control the board
member was in once the lock lifts. That happened in a passive effect, a moment
after the fields were enabled, so for one frame focus sat on the page and a test
that waited for the fields to re-enable could look before focus had returned.
Focus now returns in a layout effect, in the commit that lifts the lock.
