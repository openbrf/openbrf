---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Record charges to members (debiteringar mot medlem) and export the debiting
list: a one-off cost the board puts on a named member or on an apartment - a key
to the bike room, a replacement tag, a subletting fee, a repair charged on - with
the amount, the date, the reason, the VAT treatment and the day the basis went to
the economic manager. The board records one on a screen of its own, reads the
list for a period, and takes it away as a CSV file and as the printed page a
browser writes a PDF from.

Open BRF holds the basis for the charge and not the ledger. There is no paid
column, no status that stands in for one and no balance, and the absence is the
module rather than an omission: the accounting system is where a debt is settled,
and a second answer to whether something has been paid is worse than none. The
nearest thing to a workflow field is the day the basis went to the manager, which
is a fact about the row and says nothing about what happened to it afterwards.
Nothing here is shaped to receive the paid half either, with no export target, no
schedule and no hook, because a seam left for a thing that does not exist is a
guess about its shape.

A charge names a person or an apartment and never both, which the table enforces
along with a positive amount, a rate that belongs to the treatment carrying one
and a reason with something in it. Recording both would give two answers to who
is being charged the day the apartment changes hands. An apartment-keyed charge
is still personal data, because the flat leads back to whoever lives in it, so
both kinds sit in the service tier under the same access control, masking and
audit log as everything else.

The whole module is behind `memberCharges:manage`, which the board holds and the
external property manager does not: what the association charges its members is
its business with its own members. There is no resident half, since a member
learns what they are charged from the notice the accounting system sends, so a
resident who types the address reaches a screen that says whose it is and offers
no control the server would refuse.

A member with protected personal data is named on the list and their apartment is
withheld from it, on the member register extract's own rule and for its own
reason: the list is handed to a bookkeeper outside the association, and the link
from a name to a door is what protection exists to withhold. The name stays,
because a bookkeeper who cannot be told who to invoice has been handed a list
they cannot use. The rule holds on the screen and in the file, and the file says
"protected" beside the empty cell so the emptiness reads as deliberate rather
than as a gap.

The reason is board-written free text and is scanned for a personal identity
number when it is written and on every later edit, with the refusal naming the
field it was found in and never the value. It is copied into a file that leaves
the association, which is why the scan reaches the edit as well as the first
write.

Where the register holds two people of one name in one flat - a father and a
son - the picker names the day each of them moved in, because an option that
read the same for both would ask a board to choose between two identical rows,
and charging the wrong one puts a sum on a member it was not for. The date is
added only to the rows that need it.

Every charge is on its subject's data subject access report, by its own column or
through the apartment they were living in on the day it is dated, and each row
states the earliest date the purge can reach it. A nightly purge erases a charge
at the end of the seventh calendar year after the one it falls in, which is how
long the accounting record it was the basis for is preserved
(bokföringslagen 7 kap. 2 §), unless a legal hold stands against the
person charged or, for a charge on an apartment, against anybody who has ever
lived there.
