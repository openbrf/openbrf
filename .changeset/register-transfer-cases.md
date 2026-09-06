---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Complete Lag (2026:484) 3 kap. 3 §: every övergång gets the right reporting clock, or the right absence of a duty.

That section is four rules and the register held one of them. A reporting
obligation was raised only where the board recorded a membership decision, so an
övergång to somebody already a member, to somebody outside the membership
requirement, or to the association itself raised none at all - each of those
looks exactly like a decision nobody has minuted yet. `Transfer.reportBasis` now
says which case applies. The board states it rather than the platform inferring
it, because which case an övergång falls in turns on facts about the acquirer
this database does not hold; a trigger fixes it once stated, as it does the kind,
because the deadline computed from it sits in an append-only ledger; and a row
written before the column keeps its null and derives nothing.

Where the statute assigns the anmälan to somebody else, no duty is recorded and
the queue says whose it is. Första stycket puts the report for an övergång to a
juridical person that acquired at an executive or forced sale while holding a
lien in the bostadsrätt (BRL 6 kap. 1 § andra stycket) on that person. A row in
the ledger would be a deadline the association does not owe on a table nothing
can correct, and the board could never discharge it - but an övergång that simply
vanishes from every screen cannot be told from one nobody has recorded, so the
reporting queue lists it separately and names the anmälare.

A registered överlåtelse that has been hävd or has gone back to the seller is a
record of its own (3 kap. 3 § tredje stycket). Statutory tier and append-only on
the termination's shape, beside the transfer it undoes rather than on it: both
happened, and a register showing only one would state something that is not the
case. Its duty carries **no deadline**, because that sentence is the one in the
chapter that sets none - it says the association "ska anmäla" where 3 kap. 2 §,
the rest of 3 § and 4 § each say "inom två veckor" - so the ledger's window CHECK
now requires fourteen days of every other kind and a null of this one, and the
queue states it as owed without a day.

Förordning (2026:898) 2 kap. 4 § andra stycket's other two fields are recorded:
taxeringsenhetsnummer and fastighetstyp, reported with the fastighetsbeteckning
in place of the association's lagfarts- och tomträttsinnehav where its buildings
stand on land it neither owns nor holds with tomträtt. Whether that is so is now
recorded too, as register content beside the property designation. It is not read
off the association facts page, and the earlier claim that it could be was wrong:
the boolean there says whether the land is held on a site leasehold, so false
means the association owns it and the page has no value at all for the case the
paragraph turns on.
