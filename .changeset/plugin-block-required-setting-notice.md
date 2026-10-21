---
"@openbrf/i18n": patch
---

The page editor no longer saves a page "Saved." with a plugin's block left out
because a required setting is empty. The save is held back, the notice names the
block and the setting that is empty or no longer valid, and is announced to assistive technology, and the
block stays in the editor to fill in.
