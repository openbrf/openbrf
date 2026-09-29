---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Two board members editing the same news item could overwrite each other: the
later save silently replaced the earlier one's text. A news item now carries a
revision, as a page does. The editor sends the revision it opened, and a save
built on a copy somebody else has saved over is refused with `news-changed`
(409). The board is told that somebody else saved first, the list shows their
version, what was typed stays in the form, and saving again writes it over
theirs.

`PUT /api/news/:id` takes `expectedRevision` as optional, so older clients keep
working. The `news_update` action takes it as optional too, since the action was
armed before the field existed; a connected app that sends the revision it read
gets the same refusal. The migration adds
`news.revision` with a default of 1.
