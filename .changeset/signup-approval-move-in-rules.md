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

**Upgrade note:** the migration that adds that index first deletes every older
pending request from an address that has a newer pending one, keeping only the
newest. Such rows can only come from two submissions that arrived together,
since a submission used to replace the pending request from its address. They
were never decided, but the form is anonymous, so they need not come from the
same person: the deleted one may be the resident's own request and the one kept
somebody else's claim. The deletion is not reversible. To see them before you
upgrade, take a backup and list the pending requests whose address has more
than one:

```sql
SELECT id, "firstName", "lastName", "claimedAddress",
       "claimedApartmentNumber", "createdAt"
FROM signup_request
WHERE status = 'PENDING'
  AND "emailIndex" IN (
    SELECT "emailIndex" FROM signup_request
    WHERE status = 'PENDING'
    GROUP BY "emailIndex" HAVING count(*) > 1
  )
ORDER BY "emailIndex", "createdAt";
```

An approval whose invitation is not sent, whatever the reason, is no longer
reported as a failure. It answers `invitationSent: false`, and the board's queue
says the person is in the register and needs an invitation from the person's own
view.
