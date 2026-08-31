---
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the booking screen, its place in the navigation, and the resource settings
panel: residents can see what the house offers, take a slot and cancel their
own, the board can see who holds which hour and cancel on somebody's behalf, and
whoever configures the catalogue can name what the house has and how much of it
one apartment may hold.

The resident's calendar is a calendar of free and not free. A slot arrives as
free, booked, the reader's own, or gone, and it carries no identity at all -
which apartment holds nine o'clock on Saturday is personal data the board's own
view is gated behind, and there is nothing on the resident screen for it to be
rendered into. A slot somebody else holds says that it is held, and nothing
else. The board's half is a separate panel behind its own capability, and a
resident's screen does not ask the server for it.

Every instant a booking sends is copied from the slot it came from rather than
assembled from the date and the hour on screen. On the two Sundays a year when
the clocks move, a wall-clock time is not enough to name an instant, and the
server compares what it is sent against the slots it generates. What a reader
sees is formatted through the platform's own time-zone database in the
association's zone, so a laundry room opens at seven in December and at seven in
June, and the calendar is navigated by calendar days rather than by adding
hours - the day after the 25th of October is the 26th, although that Sunday is
25 hours long.

Two of the three modes book in one click, because taking the laundry room at
seven is one decision and the control names it. A resource booked by the night
takes two, because a stay is a check-in and a check-out and no single click
means both.

Every refusal the module can give these screens now reads as a sentence somebody
can act on. The one refusal that is two situations behind one code is split by
the limit the API names: a weekly allowance that has been spent is waited out and
a later week is open, while a limit on how much of the future one household may
hold at once is answered by cancelling something. A refusal that names no limit
keeps the sentence that is true of both.

The settings panel offers the fields the mode calls for and no others. A resource
booked in time slots carries a slot length and an opening and closing time; one
booked by the day or by the night carries none of them, and they are absent
rather than disabled, because a setting that can be changed with no effect is
the worst kind there is. Changing the mode clears them, which is what the API
requires: it reads a cleared field and an omitted one as the same thing, so a
form that left them out would ask the server to keep dead configuration. A slot
length that does not divide the opening hours is refused with the two ways to fix
it, and a resource that has already been booked says what changing its mechanics
leaves standing. Withdrawing is offered and removing is not, because the bookings
made against a resource say what they were for only through it.
