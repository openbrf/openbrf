---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the slot engine and the booking API: residents can see what a bookable
resource offers, take a slot, cancel their own, and the board can see who holds
what and cancel on somebody's behalf.

Slots are generated from the board's configuration and never stored. A stored
calendar would be a second copy of the opening hours that has to be regenerated
when the board changes them, and would be wrong until it was. A resource booked
in time slots offers its day cut into equal pieces between opening and closing;
one booked by the whole day offers one slot a day; one booked by the night
offers one night a day, and a stay runs from a check-in to a check-out.

All of it on the association's own clock. A laundry room opens at seven every
morning, including the two mornings a year that are 23 and 25 hours long, so a
time of day is converted to an instant through the calendar rather than by
adding hours - and the instant seven o'clock names moves by an hour twice a
year. The two Sundays are handled by the boundaries themselves: a slot ends
where the next one begins, so the hour the clocks skip in March simply is not
offered and the hour the wall clock repeats in October belongs to the slot that
was already running. A resource open around the clock therefore offers 23 slots
on one of those Sundays and 24 on the other, and the room still opens at seven
on both.

The double booking is refused by the database. A slot is claimed by an insert
that the partial unique index arbitrates, in the same transaction as the audit
entry that records it, so two residents claiming the same hour in the same
instant end with one booking and one refusal - and the refusal is the same
reason a read taken a moment earlier would have given. The loser's audit entry
rolls back with the insert that affected nothing, because they were never
separate acts.

The quota is derived at write time and stored nowhere. Both limits the board
sets are counted from the bookings the apartment holds, and the apartment comes
from the booker's own residency rows, which makes three things true with no
bookkeeping at all: joint holders of one apartment share one allowance because
they book against one apartment; a cancelled booking gives its share back the
moment it is cancelled; and a residency with a move-out date on the Thursday
stops that person booking the Friday, while the bookings they made before it go
on counting against the household. Nobody gets a fresh week's allowance out of
somebody moving out. The weekly limit is counted over the calendar week the
booking is for - Monday to Monday, as Sweden numbers its weeks - rather than the
week the request happens to arrive in.

Cancelling sets a status and never deletes. The record that a booking was made
stays and is erased on the same clock as any other, and because the unique index
covers live bookings only, cancelling is also what hands the hour back to the
calendar. A resident cancels their own; the board cancels anybody's, and the
entry names the board member who did it and the resident it was about.

A resident's calendar says free or taken and never who holds a slot: which
apartment has the laundry room at nine is personal data the board's own view is
gated behind. A booking that is not the caller's, and an apartment they do not
hold, are both answered exactly as one that does not exist, so neither endpoint
can be used to enumerate the building or the calendar one identifier at a time.
