---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Put the association's calendar on its public website: a page at /kalender, an
address per event, and a block the board can put on a page it writes.

The calendar is read a month at a time, and the way between months is two
anchors. A month is a query parameter, previous and next are ordinary links, and
the reader's own back button works - the website's content policy names no script
source at all, so a calendar that needed one would not run in a browser, and one
that needs none can be read with JavaScript switched off, in a text browser, and
from the address printed on a notice. Which month somebody is looking at lives in
the address bar, because the website sets no cookie and keeps no session. The
parameter is read strictly and clamped: a value that is not a month leaves the
reader on the current one, and a month outside the year back and two years
forward the calendar reaches is pulled to the nearest edge rather than refused -
there is nothing there a visitor could have got wrong. At either edge no anchor
is printed, because a link that answered with the month it was followed from
would read as a fault.

A month boundary is a wall-clock fact, like every other time in the calendar. A
midsummer party starting at half past midnight on the 21st of June is 22:30 UTC
on the 20th, so a month window worked out in UTC would file it under the month
before for part of the year. The window is derived from the same conversion the
dates themselves were written with, and it is asserted in both directions: the
date is in the month it falls in and absent from the one before it.

Which dates a reader is answered with rests on one thing, whether the request
carried a session, exactly as it does for a page and a news item. There is no
capability read on the public website and there cannot be. An event the board
published to the street is on the calendar for everybody; one published to the
members is on it for anybody signed in; a draft is on it for nobody. Asked for by
its own address, an event that is not the reader's to see is answered with the
website's own not-found document - byte for byte the same one an address naming
nothing produces, and the same one the page routes send - so somebody holding a
list of identifiers cannot tell an event that exists and is closed to them from
one that does not exist. That is a property of the service returning a single
null for all three cases rather than of the controller remembering to be careful.

How many places are gone stands beside a date. Who has taken them never does,
and that is enforced by the shape of the query rather than by what the renderer
prints: the places are read as a filtered relation count, so the only thing the
website can learn about a sign-up is how many of them there are, and no shape it
is handed has anywhere to put a name. A withdrawal does not hold a place and is
not counted. A date the board has called off says so - on the calendar page, on
the event's own page and in a block on a page the board wrote, from one renderer,
because a cancelled cleaning day shown as going ahead sends somebody down to the
courtyard on a Saturday morning.

The board puts the calendar on a page from the page editor and chooses how many
dates it shows. The block carries no dates and no names, only that number: what
it becomes is read when the page is rendered, against whoever is reading it, so
one stored page shows a visitor with no account the events published to everyone
and a member the members' ones as well. A page of an instance whose calendar
holds nothing that reader may see renders no calendar at all rather than an empty
heading - a page must not announce a calendar the association has not started
keeping, and an empty heading is also how a visitor would learn that the members
have dates they do not.

The calendar is also offered as a menu destination, so a board arranges the entry
that leads to it the way it arranges the news one, and both /kalender and
/calendar are refused as page addresses: a page written at either would never be
reached, and the board is told so while it is naming the page rather than
afterwards.
