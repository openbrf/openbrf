---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Record the register events and dates the cooperative housing register
(bostadsrättsregistret) is reported from.

Lag (2026:484) om bostadsrättsregister will make the association report three
kinds of event to Lantmäteriet, each inside two weeks. It is enacted but not yet
in force: it enters into force on a day the government sets, and that day has not
been set. Its companion Lag (2026:485) om införande is in force from 1 January
2027, and 3 § of it puts 31 December 2027 on the association's supply of what the
register is to contain. Three of the facts those reports are built from had
nowhere to live.

A termination (upphörande) now exists as a record of its own. Lag (2026:484)
3 kap. 4 § runs its two weeks from the day the bostadsrätt ceased, and 3 kap.
10 § lets Lantmäteriet order a late report in under penalty of a fine. It carries
the apartment, the day it took effect, the board's reference to what shows it,
and the ground - of which there are two, because bostadsrättslagen as amended by
Lag (2026:486) distinguishes two and no more: a föreningsstämma resolving that a
bostadsrätt which has passed to the association shall cease (BRL 6 kap. 11 §),
and the building the apartment is in being transferred or sold executively
(BRL 7 kap. 33 §). Those two sections are also the only places BRL says a
termination must be registered. The alternatives inside the second are one ground
here: the statute states them in one sentence, with one consequence and one
reporting duty.

It joins the statutory tier, which means both of the mechanisms that tier uses
and not just one. A BEFORE UPDATE OR DELETE trigger and a statement-level
TRUNCATE trigger stop every caller including the schema owner; the runtime role
is separately revoked UPDATE and DELETE, because a trigger is switched off by a
table's owner and the application connects as a role that owns nothing. It is
stricter than a transfer or a lien note, which keep UPDATE so a lien can be
released and a mis-keyed entry corrected: a bostadsrätt that has ceased has no
later state to reach. The apartment reference is RESTRICT and never SET NULL - a
statutory event may not lose what it was about.

A transfer now carries the day the association decided on the acquirer's
membership. Lag (2026:484) 3 kap. 3 § andra stycket runs the transfer report's
two weeks from that decision and not from the transfer, and the decision is
minuted by the board and derivable from nothing else the platform holds - a
transfer recorded without it cannot be repaired later, which is why the column
lands before a pilot records real transfers rather than with the reporting
screen. It is nullable, and an absent value is not a gap: the same paragraph runs
the window from the transfer itself where the acquirer is already a member or
falls outside the membership requirement, and its fourth paragraph does the same
where the bostadsrätt passed to the association, so those transfers have no
decision to date. Recording one is refused a second time rather than overwritten,
because the date is the start of a statutory window - and the control that
records it sends one request at a time, because the refusal of a duplicate would
otherwise report the failure of the request that succeeded.

The association's authoritative property designation now sits beside its
organisation number. The register holds data about the bostadsrättslägenhet
(Lag (2026:484) 2 kap. 1 § första stycket 1) which the association has to supply
by 31 December 2027 (Lag (2026:485) 3 §), except where it can be taken from
fastighetsregistret or lägenhetsregistret instead (6 §) - registers keyed on this
designation. What the register holds about the association itself is now
specified: Förordning (2026:898) 2 kap. 4 § första stycket registers its
lagfarts- och tomträttsinnehav, and andra stycket - the last of that section's
two paragraphs - reports fastighetsbeteckning, taxeringsenhetsnummer and
fastighetstyp instead of that holding, where the buildings stand on land the
association neither owns nor holds with tomträtt. The section is in force from 1
January 2027 and all of it falls inside the supply duty above. The condition is
answerable from what an instance already holds, because the association facts
record whether the land is owned or held on a site leasehold. The other two
fields are not modelled: they are needed to render a report and nothing here
renders one. The prose the board writes for the broker information page stays
where it is and keeps its purpose: nothing statutory is derived from it.

All three are recorded on the apartment register screen, inside the acting
transaction with an audit entry, and all three appear on the register extract - an
entry listing holders and transfers with nothing saying the right itself ended
would read as though the apartment were still held. The data subject access
report gains a terminations section, derived through the tenant-ownerships the
member register says a person held, the way the lien notes already are and on a
boundary rule of its own: a termination dated the day a holding ended is normally
what ended it, so it belongs on that person's report where a pledge dated the
same day belongs to the other party.

This change records the facts and nothing more. Nothing in it computes a
deadline, keeps a list of which reports are due or outstanding, tells anybody
that one has fallen due, or produces the file the first submission to
Lantmäteriet would be made from.
