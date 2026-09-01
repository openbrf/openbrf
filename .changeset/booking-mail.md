---
"@openbrf/api": minor
"@openbrf/i18n": minor
---

Confirm a booking by email, and tell the resident who made one when somebody
else cancelled it.

Two templates, both addressed to the resident who made the booking and to nobody
else, in that resident's own language. The confirmation is what the pilot wants
weekly for the guest apartment and the common room, where a claim is made days
ahead and the message is what the resident keeps. The cancellation goes out only
when the cancellation was not their own act: a resident who pressed cancel is
telling themselves, while a resident whose guest apartment the board withdrew
has no other way to find out before they open the calendar - which may be after
the visitors have arrived. The test is the actor against the person who booked,
not which of the two routes was used, so a board member cancelling their own
booking through the board's half writes to nobody.

Each message states the period in the terms its resource is booked in: a laundry
hour as a date and two times, a common room as a date, a guest apartment as a
check-in and a check-out. The times are formatted on the association's own
clock, so a slot booked for seven in the morning is stated as seven in the
morning on both of the two days a year that are 23 and 25 hours long.

Both are sent after the transaction has committed, and a failure to send is
logged rather than raised. A mail server that is down must not turn a booking
that succeeded into a refusal: the slot is held by the database by then, and a
resident who read a failure and pressed the button again would be refused for a
period their own booking is holding. The address is decrypted for the length of
one send and never held, and the log line names the booking and the class of the
failure - never the recipient, because a mail server's rejection quotes the
envelope it was given.

Mail only, and no text message. An SMS costs the association money per segment
and a laundry hour is not worth one until somebody asks.
