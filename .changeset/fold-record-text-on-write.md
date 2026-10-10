---
"@openbrf/api": patch
---

Store the free text of a breach, a processing activity and a processor agreement
the way it was checked. The scan for a personal identity number already folded
the text; the row kept what was typed, so an invisible character stayed in it.
The text is now folded once, before the scan and before the write, as a consent
note already is.
