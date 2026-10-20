---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Let a plugin read what the association has published: its news, its calendar
and when its bookable resources are taken (ADR 0032).

Three new permissions, each its own consent:

- `news:read` gives `host.news.published()`: the published news items, newest
  first, with the title, the body's paragraphs, when each was published and
  whether it is for the members or for anyone.
- `calendar:read` gives `host.calendar.occurrences()`, the occurrences of
  published events in a window of at most 92 days, and
  `host.calendar.meetingNotices()`, the notices of the general meetings called
  and not yet held.
- `bookings:readAvailability` gives `host.bookings.resources()` and
  `host.bookings.busy()`: the resources the house offers, and when each is
  taken in a window of at most 31 days.

Nothing written about a person comes with them: no author, comment or read
count on a news item, no sign-up on an occurrence (only how many places are
left), no attendance or proxy on a meeting notice, and no booker, apartment or
booking identifier on free/busy. Bookings that overlap or touch come back as one
interval, so a run of slots cannot be read as one household's habits.

The audience is on every news item and occurrence, and the host does not filter
by it: whether a members' item may go where the plugin puts it is the plugin's
declared purpose, and the board reads it on the consent screen, which states
each permission in Swedish and English. A manifest asking for `news:read` or
`calendar:read` must declare `freeText`, because the board's text may name
anybody. None of the three raises the capability floor of the plugin's routes.
