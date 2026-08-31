---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the event calendar the board arranges: the event, the rule by which it
repeats, and the dates it falls on.

An event is a series rather than a date. It carries what the board calls it,
what it is about, where it happens, which category the board sorts it under -
free text, the way the issue types and the archive's binders are - and whether
people may sign up, with how many places each date has. An event with no
recurrence is an event with one date. There is no separate model for a one-off,
no flag saying which kind it is and no second code path anywhere, because two
paths would have been two sets of rules about publishing, editing and calling
off, and the single-event one would have been the one nobody remembered to fix.

The dates are rows. They could have been computed from the recurrence every
time a calendar was read, the way a bookable resource's slots are, but a slot is
offered and claimed in the same breath while a date is signed up to - and a
sign-up is a row pointing at the date it is for, so the date needs an identity.
It is also what lets one cleaning day be rained off without rewriting the
recurrence or touching the rest of the year.

Every time is a wall-clock fact. An event states a first date, a time of day and
how long it runs, and each date's instants are worked out from those on the
association's own clock. So a cleaning day at ten in the morning is at ten in
the morning on every date it falls on, including the two Sundays a year that are
23 and 25 hours long, and the instants either side of a change differ by an hour
from what adding seven days to the one before would have given. An event stated
as nine to three is nine to three on the 23-hour Sunday too, and five real hours
long that day, because that is what the notice says. The one local time that has
no answer is the hour the clocks jump over in March: a first date there is
refused while the board is still on the form, and a later date there is left out
rather than moved an hour from where it was asked for.

A rule repeats weekly on the same weekday, monthly on the same day of the month,
or annually on the same date, every so many of them. A monthly rule on the 31st
falls on the last day of a shorter month and returns to the 31st afterwards
rather than spending the rest of the year four days early, and an annual one on
the 29th of February falls on the 28th in a common year - each date is worked
out from the first one rather than from the date before it, which is what makes
that true.

Every rule states its end, and states exactly one: a number of times or a last
date. Neither is optional, because the dates are written out when the event is
saved and nothing extends them afterwards - a rule with no end would not be an
endless series but one that stopped two years out for a reason no screen could
explain. Two years is the reach: a rule going further is refused rather than
truncated, so nothing is written out that the board did not ask for and nothing
the board asked for is silently dropped.

Editing an event does not move what people are standing on. An edit is planned
before anything is written: date by date, which rows stay, which move, which go
and which arrive. A date is matched by its place on the calendar rather than by
its instant, so moving an event from nine to ten keeps the row for the 18th of
April - and with it the sign-ups pointing at it and the board's decision to call
that one off. A row that would move or go while somebody has signed up to it
refuses the whole edit, naming the dates, on the same reading the resource
catalogue takes of a booking somebody holds: whether those dates should change
is a decision the board takes date by date, not the silent effect of saving a
form. Dates that have already started are never touched at all, so an event
whose time the board moved in June keeps its spring dates at the old time.

An event is entered as a draft and published as a separate act, and it is for
the members unless the board says otherwise - a cleaning day is arranged for the
people who live in the house, and putting one on the street is a deliberate
second answer rather than the default a slip lands on. Publication runs the same
scan for Swedish personal identity numbers that a page and a news item run, and
so does every edit to something already published, because an edit to what
people can read is itself a publication. The refusal names the field and where
in it the number sits, and never the number.

One capability carries the module and it is the board's: arranging what the
association does and announcing it are one job. The property manager is granted
none of it - they handle the association's issues, they do not arrange its
cleaning days. Entering an event, editing it, publishing it and calling off one
of its dates are each in the audit log, carrying the shape of the event, the
audience, the field names that moved and how many dates were added, moved and
dropped - and never what the event is called.
