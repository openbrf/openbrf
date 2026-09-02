---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Show the board which reports to the cooperative housing register
(bostadsrättsregistret) are owed, tell it when a window opens, and produce the
initial supply of the existing apartments.

The obligation ledger records a deadline per reportable event. Nothing read it
back, nothing said a deadline existed, and nothing assembled the data Lag
(2026:485) 3 § makes an association give Lantmäteriet by 31 December 2027. All
three now exist.

## The queue, and where "reported" lives

A screen of its own, grouping the duties by what is still owed, what has passed
its statutory deadline and what has been reported. A passed deadline is a state
rather than a row further down a list: Lag (2026:484) 3 kap. 10 § lets
Lantmäteriet order a late report in under penalty of a fine, so it is marked five
times over - its own group, that group first, the state named in words, a count
in a notice above the document, and the colour last and never alone.

Recording that an anmälan reached Lantmäteriet writes **no register row**.
`register_report_obligation` is append-only on both of the statutory tier's
mechanisms, and the model's own comment already draws the line: the event a row
reports cannot change and neither can the day the statute counts the window from,
so discharging the duty is a separate later fact rather than an edit to the row. A
`reportedOn` column would have meant relaxing both guarantees for one field. The
audit log carries it instead, and it is not the weaker home: it has the same
append-only trigger and its own `REVOKE` line, so the discharge is exactly as
tamper-evident as the deadline it discharges, and it already records who stated
it, about which duty, and when. What it adds is the day stated, which is the day
Lag (2026:484) 3 kap. 2 and 3 §§ make operative - a registration is made "vid den
tidpunkt då en fullständig anmälan kom in till Lantmäteriet". It also records the
act as what it is: the anmälan is made outside the platform, so a column would
read as a fact the system knows where an entry reads as a statement a named board
member made. Two statements about one anmälan are therefore two entries rather
than a conflict, and the queue reads the earliest.

Reading the queue is deliberately not audited, and the writes are. A duty carries
an apartment designation and two statutory dates and no personal data at all; the
acts it is about each have an entry of their own; and it is the screen a board
opens every time it meets, so an entry per read would bury the disclosures the
log exists to record.

## The notice, when a window opens

Every seat on the board is emailed in its own language, with the apartment, the
day the window opened and the day the report is due, and with nobody's name and
no personal identity number: a name in a mailbox is a name in every mail system
the message passes through.

The sending is queued rather than done on the register request, which is where
every board fan-out in this application already lives. A board has as many seats
as it has, each send is a separate SMTP conversation, and the register write has
already committed - so an unreachable mail server would hold the response open
for the sum of those attempts, and the retry that follows writes a second
termination, because a termination carries no uniqueness constraint. The job is
enqueued after the commit and inside a try/catch, which is the opposite of the
move-out reminder's ordering and for the opposite reason: that reminder cannot be
reconstructed, while this notice can, because the queue screen lists every duty
whether or not anybody was written to. Its payload is one identifier and the
handler reads the dates back from the ledger. The address is decrypted per send
and lives in one local for the length of the call; the log names a failure by
person id, obligation id and the class of what went wrong, never by address.

## The initial supply

A documented file and a printable extract of the same rows, behind a capability
of its own - `registerReport:export` - alongside `apartmentRegister:read` and
`protectedData:reveal`. It is the second operation in the product that decrypts a
personal identity number, after the data subject access report, and it is treated
as that rather than as a download: nothing is produced until somebody presses the
button, the entry names every person whose number the file carried, every column
it has and how many rows of each kind, and a `PROTECTED_DATA_REVEALED` entry goes
in beside it so that "who has seen these identity numbers" stays answerable from
one action across the whole product.

The supply is refused outright where the association cannot be identified in it -
no association record, or no organisationsnummer, which Förordning (2026:898)
2 kap. 4 § 2 registers and 3 kap. 1 § makes one of the sökbegrepp the register is
looked up by. A file that identifies nobody is not a smaller supply but one that
cannot discharge the duty, and produced anyway it leaves a download to mistake
for a completed one. The property designation is deliberately not refused on
beside them, because 4 § andra stycket makes it conditional and an absent one is
a truthful answer. The screen names which detail is missing, since two of the
three refusals are the board's own to fix.

An audit entry naming everybody an act covered is what makes the act
accountable, and the data subject access report prints an entry's context to the
person it is about - including the entries where they were the actor. So the
report now shows a reader their own membership of such a list and a count of the
rest, rather than every other holder's identifier, which is what GDPR art. 15(4)
is about. That narrows only what leaves the building on one document; the log
keeps every identifier it was written with, and the change covers the acts that
already carried these lists before this one.

**The file's shape is Open BRF's own and not Lantmäteriet's**, and it says so on
the screen. The föreskrifter that Förordning (2026:898) 2 kap. 2 § and 5 kap. 1-2
§§ leave the technical interface to have not been issued, and the register is
still being built. What is not invented is the content: the columns are the fields
Förordning (2026:898) 2 kap. 3-7 §§ enumerates, as narrowed to the supply duty by
that förordning's second övergångsbestämmelse.
`docs/register-supply-contract.md` states each column, its statutory field, and
every enumerated field an instance does not hold with the reason - so
transforming this into the prescribed form, when there is one, is a mapping
against a stable contract rather than a second reading of the statute.

Two things about the content are worth naming. **Lien notes are inside the supply
duty although they open no reporting obligation for the association**: that
standing per-event duty is the lienholder's (Lag (2026:484) 3 kap. 5 §), while
Lag (2026:485) 3 § puts the initial supply of the ones already recorded on the
association. 13 § of that act reaches only a lien that had sakrättsligt skydd before
Lag (2026:484) took effect and was not noted under 11 §, and such a lien keeps
that skydd only if the data about it reached Lantmäteriet within six months of that
act taking effect - so leaving one out of the supply can cost the lienholder the
protection itself. And **a holder with skyddade personuppgifter has their address
withheld**, with a column beside it saying so: a supply duty is not an exception
to the protection, the name and the personal identity number are what identify a
holder in a register keyed on those, and the receiving authority holds an address
through Skatteverket. The alternative address the register keeps is not put in its
place, because supplying it as the postadress a state register is to hold would be
a statement nobody made.
