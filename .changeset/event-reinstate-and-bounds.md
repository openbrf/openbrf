---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Give a called-off date a way back, bound the board's calendar to a period, and
let the server decide whether a date has begun and who it was published to.

**A date the board called off can be put back.** Removing a series is refused the
moment anybody has signed up to one of its dates, and nothing anywhere cleared
`cancelledAt`, so a board that called off the wrong date had no way back at all -
not clearing it, not removing the series, not re-entering the date, because the
unique index on the series and the start instant is the row already sitting
there. Reinstating is its own act with its own route, its own reason codes and
its own entry in the audit log: taking an announcement back and making one again
are two decisions, and a reader of the log has to be able to say which an entry
was. It is refused for a date that was never called off, for one the clock has
passed - it did not go ahead, and the calendar cannot say afterwards that it
did - and for one whose series has been removed since, whose rows cascaded with
it.

**A place freed while the date was off does not come back with it.** Somebody who
stood down because the date was called off has stood down: the withdrawal is a
date on their own row, taken by them or by the board on their behalf, and the
reinstatement neither reads it nor writes it. The place they gave back is free
from the moment they gave it and is takeable again by anybody including them, at
the back of the queue, which is what a withdrawal means everywhere else in the
module. The screen says so in the sentence it shows afterwards, the schema says
so on the column, and two tests hold it - one over the endpoints, and one whose
sign-up table throws on every method so that a service reaching for it fails
rather than passing an assertion about a row nothing looked at.

**The board's list answers for a period.** It had no bound and selected every
date of every series: the recurrence rule caps one series at 105 dates, but
nothing caps how many series a house enters, so the read grew without limit as
the module was used as intended. It now takes a window of local days, bounded to
the same two months the booking calendar answers for and defaulting to that
widest window from today, and the window is applied to the dates as well as to
which series come back. A series with no date in the period is not in the answer,
and the board reaches any other period by stating one - the panel states one on
every read and moves it a whole period at a time, so no date falls between one
period and the next. Each card states how many dates the series has altogether,
from the database's own count, so a period showing three of twelve never reads as
a series of three.

**Whether a date has begun is the server's answer.** The resident's calendar
carried the instants and left the comparison to the browser, while the booking
calendar has been sending `PAST` as one of four states per slot all along. The
row now carries the fact, decided from the same clock the claim is refused on,
and the panels read it - which is also what decides whether a called-off date is
still one that can be put back. The browser-side comparison is gone, and so is
the pinned clock its tests needed.

**A resident can see whether the same words are on the street.** The audience a
series was published to now travels on the application's own calendar, so
somebody entitled to read the members' events and the public ones both can tell
which is in front of them, and a board that published one to the street by
mistake finds out from a screen rather than from a neighbour. The public
website's payload gains nothing: who may read an event there is decided from
whether the request carried a session and from nothing else, which is what keeps
that rule in one line of one query, and a test asserts the whole key set of the
public date so a field describing an audience cannot arrive there unnoticed.
