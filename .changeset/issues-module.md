---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the issues module: reporting with photographs, the triage queue, and issue
types scoped to an audience.

The categories are the board's own vocabulary for its building, configured in
settings, and each one is offered to exactly one audience: non-member, member,
or board. Which of them a person is shown is decided on the server for every
caller - a resident picks from the member types, a caller with no session from
the non-member ones, and the board's internal categories are shown to nobody who
does not handle issues. Posting the identifier of a type that was never offered
is answered as if that type did not exist, so the catalogue cannot be
enumerated one guess at a time. A type that reports have been filed under is
deactivated rather than deleted, because those reports say what they were about
only through it.

A resident reports from the application against their own apartment or against
free text, attaches photographs, and follows the report through new, in progress
and done. Photographs go through the media layer like every other file:
identified from their own bytes, given a generated key, and served from the
association's own origin. They are internal and are attached by signed-in
reporters only.

The description is free text and is deliberately neither scanned nor refused.
An issue report is exactly where health data and a third party's details arrive
without anybody intending it, so the form carries a standing sentence saying
that everyone who handles issues - an external property manager included - reads
what is written. A reporter with protected personal data is named to nobody in
the queue, and a reporter the register no longer holds is reported as unknown
rather than invented.

Whether the association's website carries a form anyone can use is a setting,
on by default: an issue report produces a maintenance ticket rather than an
account on an instance holding a statutory register. With it off, the anonymous
audience is refused at the service, so the form stops existing rather than
being hidden.

Three capabilities carry the module. `issues:report` goes to residents and to
the board, `issues:configure` to the board, and `issues:handle` - which existed
unused - now also reaches the board beside the property manager. The navigation
follows: an external property manager is offered the issue queue and their own
settings, and the address book is no longer among their destinations at all.
