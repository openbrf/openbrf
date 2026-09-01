---
"@openbrf/api": minor
"@openbrf/web": minor
---

Cover the association's event calendar end to end against the production image,
and tick it.

The module has two halves written in different languages against different
audiences - a screen behind a session, and a server-rendered website with no
script on it - and everything worth proving here lies in the seam between them.
Each half already had its own unit and integration coverage. What neither of
them could say is that the same act reaches both.

The board enters a cleaning day and a board meeting through its own form and
publishes them to two different audiences: one field decides which, its default
is the members, and the two cards then say which each series got. Entering one
leaves a draft, because publication is a second act - it is what the audit log
records and what the personal identity number scan guards.

The street is then answered with exactly one of them, which is a stronger claim
than the public one being there: a calendar showing everything would satisfy
that. The cleaning day is on the month the address names, with how many places
are gone beside it and nobody's name anywhere on the page, and the page runs no
script, sets no cookie and asks no other company for a single byte - a typeface
has to be among the subresources before "from this instance" means anything, so
the assertion cannot be held by a page that fetched nothing. The way between
months is two ordinary links. The members' meeting is not on the calendar for a
visitor with no account and is on it for one signed in, at the same address; and
asked for by its own address it is answered with the website's own not-found
document, byte for byte the same one an address naming nothing produces, while
the same address opens for the signed-in reader - which is what makes the
refusal about the audience rather than about a broken identifier.

A resident takes a place at a date and gives it up again, and the count beside
the control is the server's answer both times: the row is read again from the
instance between the two acts, so nothing asserted here is a row a click left
behind. The last place then goes while somebody is looking at it - the refusal
is reachable no other way, because a date whose places are gone is drawn as a
statement rather than as a control. The 409 and its `occurrence-full` code are
pinned beside the Swedish sentence the screen turns them into, the row the
reader is looking at catches up in the same breath, and the instance is asked
afterwards whether anything was written for them, because a screen that had
simply never drawn a row would satisfy an assertion made against the page.

And the roll-call, which is the one list in this module that names residents. It
names the person who signed up, it keeps the one who stood down as somebody who
stood down, and the resident carrying protected personal data is a place on it
and never a name - asserted against the whole page, since an accessible name is
text like any other. The board stands one named person down from the list it is
reading and the place is counted back.

Every date the suite works with is computed from the day the run happens, on the
association's own clock, and which day a date belongs to is read from what the
server answered rather than derived from an instant: an event at half past
midnight is on one calendar day in Stockholm and on another in UTC, and the
notice in the stairwell says the Stockholm one.

ROADMAP: `[x] Event calendar with sign-ups`. Schema, API, screens, the public
website and end-to-end coverage are all green, so the box ticks - and v1.1 is
complete.
