---
"@openbrf/api": patch
---

Keep a recipient the board recorded itself off the record of processors once it
is ended.

A board member could save a new classification for such a recipient at the same
moment another board member ended it. The save then put the recipient back on
the record. Now the save is refused as it would be for any recipient that is not
there, and the recipient stays ended.
