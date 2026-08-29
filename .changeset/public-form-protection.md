---
"@openbrf/api": minor
"@openbrf/web": minor
---

Protect the forms an anonymous visitor can reach.

Every endpoint that accepts a submission without a session - asking the board
for an account, activating an invitation, and creating the first administrator
on an instance nobody has claimed yet - now sits behind a budget per client
address. The budget refills continuously rather than resetting on the minute,
it is spent by refused requests as much as by accepted ones, and a caller who
empties it is told how long to wait. Budgets are held per route, so a script
hammering one form leaves the others open, and each is set for the most
demanding honest use of that form: several residents of one household share one
address, and turning a resident away is a worse failure than a script taking a
minute longer. Reading is never limited, and neither is anything behind a
sign-in.

The account request form also carries a field no person can reach - hidden from
the screen, absent from the accessibility tree, and outside the tab order. A
submission that filled it in is dropped and answered exactly as a stored one is,
so nothing tells a script that the form has such a field or which one it is, and
nothing it sent reaches the board's queue. What waits there is what a person
wrote.
