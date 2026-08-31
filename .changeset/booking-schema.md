---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the bookable resources the association offers, the booking table behind
them, and the retention story that has to come with it.

A bookable resource is whatever the house has: a laundry room, the common room,
the guest apartment, a sauna, a roof terrace. The board names its own, the way
it names its issue types, because a fixed list of kinds would have been wrong on
the day it shipped and every entry on it would have been a synonym for one of
the three ways a thing is actually booked. Those three are what the application
knows about. Fixed-length slots inside a day, with an opening and a closing time

- the laundry room, the sauna. One whole day at a time - the common room. A
  check-in and a check-out date spanning nights - the guest apartment.

The slot length has to divide the opening hours into whole slots, and a
whole-day resource may not carry opening hours at all. Both are refused when the
board saves the resource rather than left for slot generation to work around: a
board told at the moment it can fix the problem is better served than a resident
meeting a forty-minute laundry slot at the end of the day, and a setting that
can be changed with no effect is the worst kind of setting there is.

Each resource carries two limits on what one apartment may hold, and each is set
on its own. One bounds how many unstarted bookings an apartment may hold at once,
which is what stops one of them reserving every Saturday until spring. The other
bounds how many it may make in a calendar week. Either may be left empty for no
limit, because they answer different questions: a sauna is often capped per week
and not at all concurrently, and a guest apartment the other way round. A
resource is withdrawn from booking and never deleted, so the bookings already
made against it keep saying what they were for.

How a resource is booked cannot be rewritten while somebody still holds a
booking of it. A booking carries the times it was made for and not a reference
to a slot, so turning a laundry room into a whole-day resource would leave the
resident who holds Tuesday evening holding a period the house no longer offers -
one the calendar cannot draw and the quota cannot count. Whether those bookings
should be cancelled is the board's decision, taken booking by booking, and not
the silent effect of saving a settings form. The name, the description and the
two limits stay editable throughout, and a resource nobody holds a future
booking on is the board's to reconfigure: rewriting the slots does not make last
March untrue.

The double booking is refused by the database. A partial unique index holds one
live booking per resource and start time, so two residents claiming the same
laundry hour in the same instant are sorted out by Postgres rather than by a
read the application took a moment earlier. It is partial because a cancelled
booking has to give its period back, whether that is a laundry hour or a week in
the guest apartment: a full constraint would mean a time somebody changed their
mind about could never be booked by anyone again.

The retention promise lands with the table rather than after it. A booking says
which person, in which apartment, held which period, and the purpose that is
held for ends when the booked period does - so a booking is erased a year after
it ends, on its own clock and not on the one that governs a former resident's
contact details. Somebody who still lives here has no more use for last March's
sauna hour than somebody who has left. A nightly job does the erasing, one
person per transaction, and a legal hold stops it for the person it stands
against: a dispute that keeps somebody's contact details keeps the bookings the
dispute may be about. The data subject access report lists every booking a
person still has on file and states, per row, the earliest date the purge can
reach it - the earliest, because a legal hold defers it, and the report says on
the same page whether one stands. Bookings erased in an earlier year are not on
it: what remains of them is the entry in the audit log saying how many went and
when.

Three capabilities carry the module. Booking and cancelling one's own is
residents' and the board's; seeing and cancelling anyone's, and configuring the
catalogue, are the board's. The property manager is granted none of them: they
handle the association's issues, they do not live in the building, and a laundry
hour held by an external contractor is an hour taken from a household.
