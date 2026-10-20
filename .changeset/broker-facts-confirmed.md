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
them without changing anything, with "Bekräfta att uppgifterna stämmer". That
is refused (409 `nothing-recorded`) while no fact is recorded, including after
the board has cleared every fact. A connected app cannot: an `association_facts_update` call that changes no fact
is recorded but moves no date and confirms nothing. The
screen shows the date beside that button. Each confirmation is written to the
audit log as `ASSOCIATION_FACTS_CONFIRMED`, with the date it replaced; a save
is recorded as before.

The board also sets how many months the facts count as current after a
confirmation: from 1 to 12, and 3 unless it changes it. The setting has its own
field and its own save on the facts screen
(`PUT /api/site/facts/stale-after-months`, `site:manage`). Changing it confirms
nothing and leaves both dates alone. Each change is written to the audit log as
`ASSOCIATION_FACTS_STALE_AFTER_CHANGED`, with the old and the new number.

On upgrade, an association that has already recorded facts gets the date of
its last save as its confirmation date, and 3 months. No operator step is
needed. The `association_facts_get` action now also returns `confirmedAt` and
`staleAfterMonths`.
