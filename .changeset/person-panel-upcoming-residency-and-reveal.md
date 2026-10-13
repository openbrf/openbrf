---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

On the person panel, a residency that begins ahead of today is now marked
"Kommande" (upcoming) instead of "Pågående", by the same dates the server holds a
residency by.

While a person's masking is being changed, and until the protected person has
been read back, no personal data can be revealed into the panel. A reveal asked
for before the change no longer lands afterwards, and one that was let go of no
longer clears the busy state of a newer reveal of the same field.
