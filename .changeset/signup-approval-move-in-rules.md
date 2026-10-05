---
"@openbrf/api": minor
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Approve a sign-up request under the same rules as a move-in.

An approval always records a resident and refuses a request that asks for a
role, since membership is entered by a move-in and its member register row. It
takes the person's residency lock, refuses a second residency on the same
apartment, closes a granted erasure request the move-in overtakes, and dates
the residency by the calendar day in Stockholm.

A request is linked to a person already in the register only when exactly one
person has its email address; when several do, the approval is refused with
`email-shared` so the board can sort out the addresses first.

The first pending request from an email address now stands: a later submission
from the same address is answered as before and stored nowhere, and a partial
unique index keeps one pending request per address.

An approval whose invitation cannot be sent is no longer reported as a failure.
It answers `invitationSent: false`, and the board's queue says the person is in
the register and needs an invitation from the person's own view.
