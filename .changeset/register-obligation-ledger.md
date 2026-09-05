---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Turn each recorded register event into a dated duty to report it to the
cooperative housing register (bostadsrättsregistret).

Lag (2026:484) 3 kap. gives the association two weeks to report a register event
to Lantmäteriet, and 3 kap. 10 § lets Lantmäteriet order a late report in under
penalty of a fine. The dates those windows run from landed with the termination
and the membership decision; nothing computed a deadline from them. A reporting
obligation (anmälningsskyldighet) now does: one row per reportable event, stating
which event it is about, the day the window opened and the day it closes.

Which day that is differs by paragraph, and the ledger counts from the one the
statute names rather than from a single convenient date. A transfer runs from the
day the association decided on membership - 3 kap. 3 § andra stycket, "inom två
veckor från det att bostadsrättsföreningen beslutat om medlemskap i föreningen" -
and not from the transfer, which completes on the tillträdesdag and is usually
the later day, so counting from it would state a deadline after the statutory one
had passed. A termination runs from the day the bostadsrätt ceased (3 kap. 4 §)
and never from the day the board typed it in, so a termination recorded late
arrives with its window already open or closed, which is the true state and the
one the fine attaches to.

Each row is written by the same transaction as the register write it is computed
from, never by a job that looks for events afterwards: a ledger assembled later
is one that can be missing a deadline nobody notices is absent. The coupling runs
both ways, so a register write whose deadline cannot be entered does not happen
at all rather than committing without it.

It joins the statutory tier on both of the mechanisms that tier uses. A
BEFORE UPDATE OR DELETE trigger and a statement-level TRUNCATE trigger stop every
caller including the schema owner; the runtime role is separately revoked UPDATE
and DELETE, because a trigger is switched off by a table's owner and the
application connects as a role that owns nothing. It is as strict as a
termination rather than as a transfer: the event a row reports cannot change and
neither can the day the statute counts from, so discharging the duty is a
separate later fact about a report that was made and not an edit to the row.
Every reference it carries is RESTRICT, because a deadline that lost the event it
was about would be a false record rather than a shorter one. The database states
the rest of the shape as well: the two weeks as a CHECK, so no writer can enter a
window that is not fourteen days, one deadline per event as a unique constraint,
the event reference matching the kind, so a row cannot report one paragraph's
event on another paragraph's clock, and a trigger tying the row to the event it
names - the apartment is the event's own, the day the window opened is the date
that event carries, and a transfer with no recorded membership decision takes no
row at all, because the paragraph gives no day to count from.

Liens are deliberately absent and are not an oversight to correct. 3 kap. 5 §
puts the anmälan on the panthavare, who signs it together with the pledgor, and
6 § lets Lantmäteriet authorise one to register pledges on its own, so no lien
note opens a duty for the association.

A person's own duties appear on their data subject access report, for GDPR art.
15(1)(c) rather than for the dates the transfer and termination sections already
carry: the ledger is the association's only record that their data is to go to a
recipient outside it. An obligation names a register event and never a person, so
it is reached through the events already on that report rather than through a
derivation of its own - and a transfer's duty reaches the acquirer alone, because
its due date less fourteen days is the membership decision date the report
withholds from the seller on purpose.

This change records the duties and their deadlines. Nothing in it lists which are
outstanding, tells the board when one falls due, or produces the file a report to
Lantmäteriet would be made from. Two duties whose window the statute runs from
the event itself rather than from a separately recorded date are also absent from
the ledger - a transfer to somebody already a member or outside the membership
requirement, and one where the bostadsrätt passed to the association under 3 kap.
3 § andra and fjärde styckena - because neither is distinguishable from what an
instance records today. The third of those cases, a grant under 3 kap. 2 §, was
in that list until the register began recording which of its events are grants;
a grant now opens its obligation on the day of the grant itself.
