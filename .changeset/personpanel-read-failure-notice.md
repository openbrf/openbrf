---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

The notice that a protection change was sent but the person could not be read back is now shown only while that read-back is pending, so a later read that fails no longer repeats it. A lien release that got no answer, where the register shows the lien still open, now says it was not recorded and can be tried again, rather than showing the refusal message.
