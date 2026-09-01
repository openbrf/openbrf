---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add sign-up to the event calendar: a resident puts their name down for one date,
stands down again, and the board sees who is coming.

A sign-up attaches to one occurrence and never to the event, which is the whole
reason the dates are rows. Somebody signs up for the cleaning day on the 18th of
April, and the places are counted against that date - so twenty places at each of
a year's cleaning days is twenty places twelve times over rather than twenty for
the year. One row per person and occurrence, for as long as it is kept - the
purge below is what ends it, and nothing before then writes a second one.

The place is claimed rather than checked for. One sign-up per person and date is
a statement about a single row, so a unique index holds it and a second claim
matches nothing instead of writing a second row. The capacity is not that shape:
"at most twenty standing sign-ups for this date" is a statement about a set of
rows measured against a number stored on the event, which no constraint can
express and which no single statement can settle either - at the isolation level
everything here runs at, a statement counting rows cannot see a claim that
committed while it was waiting. So a lock keyed on the occurrence is taken before
anything the decision rests on is read, and the count behind it is decisive
rather than true-when-it-was-taken. Two residents claiming the last place in the
same instant produce one place taken, one refusal with the reason a read would
have given, and one entry in the audit log.

Standing down writes a date on the row and never deletes it. Who was expected at
a cleaning day and who changed their mind are two different answers, and a
deleted row can only give the first by omission. It is also what makes the place
countable: the places taken are the sign-ups without a withdrawal date, so
standing down frees a place the moment it is recorded and a neighbour can take
it with nothing recomputed. Signing up again reopens the same row - at the back
of the queue, because somebody who gave a place up has no claim on it.

A withdrawal does not hold a date. The board may reshape or remove an event
somebody stood down from, which is the difference between recording a date and
locking the calendar; a sign-up nobody withdrew does hold its date, including one
the board has already called off, because calling a date off is a statement about
the association's plan and not about who is still expecting to be there. The
board's way out is a withdrawal on that person's behalf, which is one recorded
act per person rather than the silent effect of saving a form.

How many places are gone is what the calendar a resident reads carries. Who has
taken them is personal data about other residents and is behind the managing
capability, on its own controller, and a person with protected personal data is
on that roll-call as a place and never as a name - the statutory registers have a
reason to print those names and a list read in a stairwell doorway has none. The
ones who stood down stay on it with the date they did.

Signing up is its own capability, held by residents and the board. It answers
what a principal may do, which is a different question from whether they may edit
their own record: somebody with an account and no residency holds the second and
not the first.

Every date this reports is the association's own. A midsummer party starting at
half past midnight is on the 21st of June in Stockholm and on the 20th as an
instant, and the day it is filed under is the one the notice in the stairwell
says - on the screen, on the roll-call and on the access report alike.

Both acts are in the audit log, carrying the identifiers, the date and the state
of the places, and never what the event is called. A withdrawal names the person
whose place it was as the subject whoever asked for it, so their own access
report shows a withdrawal somebody else decided on.

Same change: the access report gains a sign-up section stating each row's own
erasure date, the withdrawals included, and a nightly purge erases a sign-up a
year after the date it was for ended - on the occurrence's clock rather than the
residency one, with a legal hold standing against the person stopping it both in
the scan and inside the transaction that deletes.
