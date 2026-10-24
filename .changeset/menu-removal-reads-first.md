---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

On the menu screen, a removal no longer takes an entry the board saw outside its dropdown. After a move that did not go through, or an addition, an edit or a removal that got no answer, the screen reads the menu before it sends a removal, and sends it only if the entry's dropdown there is the one the board saw. Otherwise the entry stays, the board is told that it was not removed and why, and the menu is read again.
