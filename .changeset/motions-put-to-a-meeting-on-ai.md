---
"@openbrf/api": minor
"@openbrf/i18n": minor
---

A new read action, `motion_meeting_list`, lists the motions the board has put to
one general meeting, so an AI package drafting that meeting's agenda can place
them. Each motion comes with its title and whether the board has acknowledged
it, oldest first. A motion the member has taken back is left out.

The read has no field for who submitted a motion: it returns no name, no person
id and no sign that a name was withheld, and it does not return the motion's
body. That omits the submitter's data, not what the member wrote: a title is
returned as written, so it can itself name or identify its author, or anybody
else. The read does not redact titles. It needs `motions:handle`, as the board's motion queue does, and is offered to
connected apps and to an AI package. It is the only motion action an AI package
is offered: the queue, which names the member behind each item, and the two
writes stay off the `ai` surface.
