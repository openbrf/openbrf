---
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/api": patch
---

The install consent screen and `openbrf plugin add` now name the installed
plugins that installing a plugin would hold to the board. When a plugin joined
to them by extension points reads the address book or the finances, their
routes answer only the board and the administrator from the restart the
install ends in, and their views are offered only to them (ADR 0052). An addon that reads the address book can
therefore take its host plugin, and that host plugin's other addons, out of
residents' reach, and the board now reads that before it consents. The
sentence appears only where the install raises a plugin's floor.
