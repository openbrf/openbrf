---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

The broker information page (`/maklarinfo`) now says when the board last
confirmed its facts: "Styrelsen bekräftade senast uppgifterna den 14 mars
2026." It appears under the title once at least one fact is recorded.

Saving the facts confirms them. On the facts screen the board can also confirm
them without changing anything, with "Bekräfta att uppgifterna stämmer". The
screen shows the date beside that button. Each confirmation is written to the
audit log as `ASSOCIATION_FACTS_CONFIRMED`, with the date it replaced; a save
is recorded as before.

On upgrade, an association that has already recorded facts gets the date of
its last save as its confirmation date. No operator step is needed. The
`association_facts_get` action now also returns `confirmedAt`.
