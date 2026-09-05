---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Record an upplåtelse as the event it is, and raise the duty it opens.

A grant of a tenant-ownership was stored as a transfer with no seller, which is
also what a transfer out of a hand the register never held looks like - and a
register that began part way through a building's life is full of those. The two
were the same row, so the platform could not raise the reporting duty Lag
(2026:484) 3 kap. 2 § lays on the association for the first without risking it on
the second, and the apartment register printed "Upplåtelse" for both.

`Transfer.kind` now says which. The board states it when it records the move, a
CHECK requires it of every new row, and a second CHECK refuses a grant that names
a seller, because the right comes into being and has nobody to pass from.

The obligation ledger gains `GRANT`. Its window opens on the day of the grant
itself - the one duty in that chapter that needs no second date recorded first -
so it is entered by the transaction that records the grant rather than by a later
act, which is the rule the ledger already held for the other two. The database
checks the transfer's own kind against the obligation's, so an övergång cannot be
put on the grant's clock or the other way round.

A row written before the column existed carries no kind and takes no duty.
Nothing derives one: what such a row was is not recorded anywhere, and a guess
in a statutory register is a statement nobody made.

The screens follow. The move-in panel asks which event is being recorded and
offers the previous holder only for a transfer; the apartment register prints
"the register does not hold the seller" where that is what happened, and states
that a grant is reported from the grant rather than offering to record a
membership decision the server would refuse.
