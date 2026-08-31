---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Confer and revoke a role from the application: a board seat, the administrator
grant and the external property manager grant.

The authorization model was already enforced and had no write path. A residency
and its member or resident role were written by the move-in, by the import and
by an approved sign-up request, but a board seat and the two system roles had
no screen and no endpoint, so a housing cooperative entered them as SQL, which
also meant a second administrator could not be created and an instance that
lost its only administrator had no way back in.

Who may confer what is a capability rather than a role check, like everything
else in this codebase. Recording an election to a position of trust is the
board's own: a board is elected by the general meeting, the application holds
the minute of that election, and an instance whose board could only be recorded
by an administrator would make the administrator the gatekeeper of the
association's constitution. The seat it writes carries nothing its writer does
not already hold, so it cannot be used to climb.

Granting a system role is an administrator's, and the board holds no capability
that reaches that table. A board seat is therefore not a way to grant oneself
administrator rights, and the guarantee is that no route exists on which a board
member can write the grant rather than that a check inside one refuses it. The
external property manager grant sits on that side with the administrator grant,
although what it confers - the issue queue, and never the address book - is a
subset of what a board member already holds: it is a standing grant to somebody
who neither lives in the building nor was elected to anything, which is the same
kind of decision as installing a plugin. It also keeps the board away from that
table entirely, which is the point.

A position of trust is history rather than state. An election carries the date
the meeting was held, not the day somebody typed it in, and ending a term writes
the date it ended and leaves the row where it was: who answered for the
association between two dates is exactly what a seat records, and a table that
deleted the row when the term ran out could no longer answer for the years it
covered. A re-election is two acts rather than an edit, so both periods stand
with their own dates; a second election onto a seat still held is refused rather
than merged, because one row cannot carry two elections.

An end date ahead of today is an ordinary date, so a board can minute in April
that a term runs to the annual meeting and the access follows it without anybody
remembering to come back. Which is exactly why it is bounded and why it can be
corrected: the seat goes on conferring what a board member holds until that date
arrives, so a term recorded as ending in 2206 rather than 2026 would confer it
for the rest of the instance's life. A date past a plausible horizon is refused
with a sentence saying to check the year, and a date that has not yet arrived
can be written again from the same screen, which is what makes a mistyped year
recoverable without a hand in the database. Once the date has passed the term is
settled: the seat stopped conferring on that day, and the period it covered
stands as recorded.

A system role is a fact about today, so a revoke removes the row and the audit
log is what remains to say who held what and between when. A change that changes
nothing writes nothing, which is the rule the protected personal data flag and
the publication consents already follow: granting a role that is held answers
with the state as it is rather than putting a date in the record that nobody
chose.

The instance cannot be shut from the inside. The last administrator cannot be
revoked, including by that administrator revoking their own grant, which is how
it would actually happen - somebody tidying up their own account rather than
removing a colleague. The count is taken under a lock on the grant being
changed, so two revokes racing each other cannot each see two administrators and
each remove one. The refusal says to grant the role to somebody else first,
because "try again" is advice that cannot work.

Every election, end of term, grant and revoke is written to the append-only
audit log in the same transaction as the change it records, with two new
actions for the board seats beside the two system role actions that already
existed. The screen is the person view in the register, beside the publication
consents and the legal hold, and each half is offered only to whoever holds the
capability behind it. A conferred role is in force on the next request with no
account touched, because roles are derived from the register rather than stored
on the account.
