---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

A lien could be noted twice by clicking "Note the lien" again while the first
request was still on its way, and the apartment register keeps every lien note
for good. The button now waits for the answer.

Releasing a lien took one click and was always dated today. Release now asks for
the day first, opening on today and bounded by the day the lien was noted and by
today on the association's calendar, and records it once however often it is
confirmed.
