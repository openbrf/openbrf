# The accounting basis

What Open BRF produces when a board exports a period's fees and charges for
whoever keeps the association's books, exactly what each column means, and what
the file deliberately does not say.

## What this file is, and what it is not

The accounting basis (bokföringsunderlag) is one file holding both halves of a
period's money: the fee notices issued in it and the charges dated in it. It
exists so that the figures are handed over once, in a shape somebody maps into
their own system once, instead of being read off two documents and typed in
again.

**It is not an accounting file.** There are no account numbers, no verification
series, no debit and credit and no balances. Open BRF holds no ledger and no
chart of accounts, and which numbers an association posts to is its own
bookkeeper's question - see "Why this is not an SIE file" below, which is where
that decision is written down.

**It is not an invoice.** An annual fee is exempt from value added tax under
mervärdesskattelagen (2023:200) 10 kap. 35 §, and a line that 10 kap. 36 § makes
taxable - a parking space, a storage box, advertising space, commercial premises
let under voluntary tax liability (frivillig skattskyldighet) - needs a real
invoice, which Open BRF does not produce. `docs/fee-notice-contract.md` states
that in full.

**It records no payment.** There is no paid column, no outstanding column and no
status that stands in for one. The accounting system settles the debt, and a
second answer to whether something has been paid is worse than none.

**It is a disclosure.** Every row is a copy of a named apartment's or a named
person's money leaving the association for a recipient outside it. Producing the
file writes an audit entry naming who produced it and for which period, and
nothing about what was in it; the entry is kept for as long as the instance
exists, which is why it carries no apartment, no name and no figure. Taking the
file needs both the fee capability and the charge capability: a seat holding one
of them may take that half's own document and not this file.

## Why this is not an SIE file

SIE is the Swedish interchange format for accounting data, published by
Föreningen SIE-gruppen; the current edition is "SIE filformat", utgåva 4C, dated
2025-08-06, and it is freely downloadable. An SIE export was considered for this
box and declined. The argument is recorded here because it was a close question
and whoever revisits it should have it rather than rediscover it.

**A 4I file would have been legitimate.** SIE 4 has two directions, and the
import direction - type 4I, a transactions file (transaktionsfil), the file a
feeder system (försystem) writes for the system that keeps the books - is the
case Open BRF is in. Three findings made it fit rather than merely tolerable:

| Record                                                      | In a 4I file | Why it matters here                                                                                                                                                         |
| ----------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#IB`, `#UB`, `#OIB`, `#OUB`, `#RES`, `#PSALDO`, `#PBUDGET` | forbidden    | The balance records Open BRF cannot produce, because it keeps no ledger, are the records the file type does not allow. The platform would not be working around the format. |
| `#KONTO`                                                    | optional     | Mandatory in every other SIE type. An importing program is assumed to hold the accounts already, so a producer that has no chart of accounts is not obliged to invent one.  |
| `#VER` series and number                                    | may be empty | A feeder system writing 4I may leave both to the receiving program, so Open BRF would not have to invent verification series (verifikationsserier) either.                  |

**What it would have cost.** The encoding is IBM PC 8-bit extended ASCII,
codepage 437, and no other value is allowed; Node's Buffer supports no legacy
code page and this repository carries no transcoder, so a 256-entry table with a
documented fallback would be written and maintained here. The quoting rule is
the specification's own - quotes only where a field contains a space, a
backslash before an embedded quote, and no escape for a backslash itself - and
is not what any CSV writer does. Every voucher must be validated to sum to zero
before it is written. And there is no library: every SIE package published for
this language is a reader, a work in progress, or abandoned, so the writer would
be written here and kept correct here.

**What was taken instead.** A documented CSV in the dialect the debiting list
and the fee notice document already use, with the column contract below. The
cost of that is a bookkeeper mapping eleven columns once, in a program that
imports mapped files as a matter of course. The cost of the other is a
transcoder, a quoting rule and a writer, in this repository, for as long as the
platform exists.

**If the trade is revisited**, revisit it against the specification named above
and against this section, and note what would change: a 4I file needs account
numbers per fee kind and per charge, which means the board stating them as
per-association data. No number may be hardcoded, because charts differ: 1510 is
rent receivables (hyresfordringar) in a housing cooperative's chart and trade
receivables (kundfordringar) in BAS, and the annual fee is a 302x account rather
than the 3011 that looks right. The BAS chart itself must not be vendored: the
machine-readable edition is a licensed product.

## What a period holds

The board states a period as two calendar dates, inclusive at both ends. The
period is not bounded beyond that; how far back one can reach is bounded by the
nightly purge. That erases a charge, and a notification run with its notices,
through the seventh year after the end of the calendar year in which the
financial year it was entered in ended (bokföringslagen (1999:1078) 7 kap. 2 §).
Which financial year that is was stamped on the row when it was written - on the
charge itself, and on the run rather than on each notice - so a later change to
the association's setting moves no row's erasure date and no file this export
could produce.

**A charge is in the period when the day it is dated is.** That is the debiting
list's own rule, and `chargedOn` is the day the bookkeeper posts it to.

**A notification run is dated by the day its period opens.** Its notices are in
the export when that day falls in the period, whatever the run's own period does
afterwards - so a run billing January to March appears in an export of the first
quarter and in an export of the whole year, and in neither an export of February
alone nor one of the second quarter.

A run is carried whole rather than split because a notice's amount is what was
billed for the entire run, and this product refuses to apportion one: a part
period needs a division of kronor by days, which has no answer that is a sum of
kronor and öre. The consequence is worth stating plainly, because it is what
makes the file safe to use as a running record: **over consecutive periods every
run lands in exactly one export.** Nothing is counted twice and nothing falls
between two. The row states the run's own period in `periodFrom` and `periodTo`,
so a reader can always see what a figure covers.

## The dialect

Semicolon-separated with a byte order mark, in UTF-8: the same dialect as the
debiting list, the fee notice document and the register supply file, because the
file is opened in the spreadsheet whoever keeps the books already has and Excel
reads an unmarked UTF-8 file as the local code page.

The header row is stable and in English, like every identifier in this
repository, because a mapping into another system is written against it. A row
is read by position once the file has left the application, so the header and
the cells are written from one list and cannot disagree.

**There is no total row.** A trailing row that is not a record is what breaks a
mapping written against the header. The totals are on the screen that produced
the file: the fee half, the charge half and the two together, because the halves
are posted to different accounts.

**The order is stable.** The fee rows first, by the day their run opens and then
by payment reference, which is the order the run numbered the apartments in -
the house, then the apartment number. Then the charge rows, by the day they are
dated and then by the order they were recorded in. Two exports of one period
produce the same file unless the rows themselves changed.

## The columns

| Column              | What it holds                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`              | `FEE_NOTICE` or `MEMBER_CHARGE`: which half of the association's money the row came from. Stated rather than left to be inferred from which of the later columns are empty.        |
| `periodFrom`        | "YYYY-MM-DD". The first day the row covers: the run's opening day on a fee row, and the charge's own day on a charge row.                                                          |
| `periodTo`          | "YYYY-MM-DD". The last day the row covers. Equal to `periodFrom` on a charge row, so every row answers the same question in the same two columns.                                  |
| `apartment`         | `<street> <number> <apartment number>`, as both registers print it. Empty where it is withheld, and empty on a charge put on a named person whose apartment the register has lost. |
| `apartmentWithheld` | The word `protected` where the apartment is withheld, and empty otherwise. See below.                                                                                              |
| `name`              | The person the charge was put on. Empty on every fee row and on a charge put on the apartment itself. See below.                                                                   |
| `amount`            | Kronor and öre with two decimals and a full stop, e.g. `10351.50`. What was billed or charged, frozen as the row holds it.                                                         |
| `vatTreatment`      | `EXEMPT` or `RATE` on a charge row. Empty on a fee row. See below.                                                                                                                 |
| `vatRatePercent`    | The rate in whole percent, e.g. `25`, and set exactly where `vatTreatment` is `RATE`.                                                                                              |
| `reason`            | The board's own words for what is being charged. Empty on a fee row, which has no free text of its own.                                                                            |
| `paymentReference`  | The nine-digit reference the payment of the notice is made under, by the rule `docs/fee-notice-contract.md` states and works through. Empty on a charge row.                       |

Which columns each kind of row fills:

| Kind          | Fills                                                                                               | Leaves empty                                      |
| ------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| FEE_NOTICE    | the apartment, the run's period, the amount, the payment reference                                  | the name, the value added tax columns, the reason |
| MEMBER_CHARGE | the day, the amount, the value added tax columns, the reason, and the apartment or the name or both | the payment reference                             |

A charge row carries no payment reference because a charge is billed from the
accounting system, which issues its own; Open BRF holds the basis for it and
issues nothing it could be matched against.

## Protected personal data

**A charge put on a person with protected personal data carries their name and
withholds their apartment.** That is the debiting list's own rule: a bookkeeper
who cannot be told who was charged has been handed a file they cannot use, and
what protection exists to withhold is the link between a name and a door. The
row says `protected` in `apartmentWithheld` rather than leaving a blank cell,
because somebody reading a blank cell would otherwise ring the board about a
file they would be told is correct.

**The fee half of this file names nobody at all.** The apartment is the party a
fee is fixed on under BRL 9 kap. 13 §, and who holds it is on the fee notice
document rather than here.

That omission is deliberate and it is what keeps one masking rule in this file
instead of two opposite ones. The notice document withholds a protected
household's names and prints the apartment; the debiting list withholds a
protected person's apartment and prints their name. A file that carried both
would say, of one apartment, that its holders are withheld, and of one person,
that their apartment is withheld - and a reader holding the two rows could put
the name back against the door. So the accounting basis withholds in one
direction only.

A board handing over both this file and the notice document for the same period
has handed over both halves again, and the inference is available to whoever
holds them. That is the board's own decision about what it sends to whom; this
file does not make it for them.

## Value added tax

**A charge row carries its treatment and its rate**, exactly as the board
recorded them.

**A fee row carries neither, and this is the file's one real gap.** A notice is
one frozen figure per apartment, summed across the fee kinds that apartment
holds and across the months of the run. Splitting that figure by value added tax
would mean reading the rates back and multiplying them again, which is a second
answer to what was actually billed - and a rate recorded afterwards, or a rate
corrected, would make the two answers differ. A notice is an accounting record
(räkenskapsinformation) and bokföringslagen 7 kap. 1 § forbids altering what is
preserved; the amount is what was billed and it stays that.

Where the split is read instead: the fee register, which carries the treatment
and the rate per apartment and per fee kind, on the fees screen. For most
associations the question does not arise - an annual fee is exempt under
mervärdesskattelagen 10 kap. 35 § - and where it does, the taxable line needs an
invoice Open BRF does not produce at all.

## Correcting what is in the file

**Nothing in it is edited.** A notification run and its notices are accounting
records (räkenskapsinformation, bokföringslagen 1 kap. 2 § 9, through 5 kap.
6-7 §§) and 7 kap. 1 § forbids altering what is preserved, so a correction is a
new act recorded wherever the association keeps its books. A charge is
correctable on the charges screen, and correcting one changes what a later export
of that period says - so a file is produced again rather than edited, and the
audit log says when each one was taken.
