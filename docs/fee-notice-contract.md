# The fee notice document

What Open BRF produces when a board issues a period's fee notices, exactly what
each column means, and what the association has to check for itself before it
sends anything.

## What this document is, and what it is not

A fee notice (avi) states what one apartment is billed for one period and the
reference the payment is made under. Open BRF **produces** the document; it does
not send it. The board takes it away as a CSV file or as the printed page a
browser writes a PDF from, and hands it on by whatever route it already uses.

It is **not a faktura.** An arsavgift is undantagen from value added tax under
mervardesskattelagen (2023:200) 10 kap. 35 §, and nothing in that act's 17 kap.
engages for a supply to a private member in the first place. The document is
built to bokforingslagen (1999:1078) 5 kap. 7 §'s field list - when it was
compiled, when the affarshandelse occurred, what it concerns, the amount, the
motpart and an identifying reference - and to nothing else.

**A line that is taxable does need a real faktura, and Open BRF does not produce
one.** ML 10 kap. 36 § takes parking spaces, storage boxes and advertising space
back out of the exemption, and a lokal under frivillig skattskyldighet is taxable
too. An association billing any of those through this document still owes its
counterparty a faktura from wherever it keeps its books. The fee rate carries a
VAT treatment so that the figures are there to build one from; producing it is
out of scope and is not planned in this box.

It records **no payment.** There is no paid column, no outstanding column and no
status that stands in for one, on either the fee or the notice. The accounting
system settles the debt, and a second answer to whether something has been paid
is worse than none.

## What a period is

Whole calendar months, opening on the first of a month and closing on the last of
one. A period that is not is refused.

A fee rate states what an apartment pays for **one calendar month**, and the
notice multiplies that by the months in the period. That is exact in ore. A
yearly figure divided by twelve is not - 10 000,00 kr across twelve months has no
answer that is a sum of kronor and ore - and this product refuses a malformed
amount rather than rounding one. A part month would need a division of kronor by
days, which is the same problem.

**A month is billed at the rate in force on its first day.** A rate that begins
in the middle of a month first bills the month after; one that ends in the middle
of a month bills that month in full.

**A period may be issued once, and two runs may not overlap.** A month billed
twice would give the association two answers to what it asked for, and two sets
of payment references for one month's money.

## The payment reference

Nine digits:

    2 6 0 1   0 0 0 7   8
    YYMM      NNNN      check

- **YYMM** - the two-digit year and two-digit month the billed period opens in.
- **NNNN** - the notice's position in its run, counting from 1, over the
  apartments in register order: the house, then the apartment number. A run of
  more than 9 999 notices is refused rather than wrapped.
- **check** - a modulus 10 check digit over the eight digits before it. Every
  second digit from the right of the payload is doubled, the digits of each
  product are added rather than the product itself, and the check digit is what
  brings the total to a multiple of ten.

Worked by hand for the example above: payload 26010007. From the right, 7 doubles
to 14 and contributes 1 + 4 = 5; 0 stays 0; 0 doubles to 0; 0 stays 0; 1 doubles
to 2; 0 stays 0; 6 doubles to 12 and contributes 3; 2 stays 2. The total is 12,
so the check digit is 8.

The reference is **not** built from the apartment's number, which is the first
thing anyone tries. An apartment number is unique within an address and not
within the association, so two houses may each have a flat numbered 1101 and a
reference built on it would put two households' money under one number. The
apartment is on the notice beside the reference.

Modulus 10 catches every single mistyped digit and every transposition of two
adjacent digits **except a 0 swapped with a 9**, which is the known gap in the
method rather than a fault in this use of it.

### What the association has to check

**Whether your bank accepts this shape is your agreement with your bank, not a
promise this platform makes.** An OCR format - its length, whether it carries a
length digit, and whether the bank checks it at all - is agreed between an
association and its own bank. Open BRF publishes the rule above and computes by
it.

Check one reference against your bank's specification before you issue a period
to four hundred households. If the shapes do not match, the notices still state
what is owed and where to pay it; what will not work is the bank matching a
payment to a notice automatically.

## Where the money goes

The document prints the association's bankgiro and plusgiro as the board recorded
them in the settings, **exactly as written**. Open BRF checks the shape - digits
and hyphens - and never that the number exists: whether a number is live is
Bankgirot's or Plusgirot's answer, and this platform has no way to ask it. The
number is never reformatted, because a member matching a notice against their
bank statement needs the number to read the way the bank prints it.

An organisationsnummer is printed because banks and payers want it. No statute
requires it on a document of this kind: lagen (2018:1653) om foretagsnamn
contains neither the word faktura nor the word organisationsnummer, and lagen om
ekonomiska foreningar has no counterpart to aktiebolagslagen 28 kap. 5 §.

## The columns

The file is semicolon-separated with a byte order mark, in UTF-8: the same
dialect as the debiting list and the register supply file, because it is opened
in the spreadsheet the board already has and Excel reads an unmarked UTF-8 file
as the local code page.

The header row is stable and in English, like every identifier in this
repository, because a mapping into another system is written against it.

| Column             | What it holds                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apartment`        | "<street> <number> <apartment number>", as both registers print it. Never withheld: the apartment is the party the fee is fixed on.                                           |
| `apartmentNumber`  | The apartment's own number, e.g. "1101", which is what a board sorts and searches by.                                                                                         |
| `holders`          | The names of the tenant-owners holding the apartment when the period closed, comma-separated. Empty where withheld - see below.                                               |
| `holdersWithheld`  | The word `protected` where the names are withheld, and empty otherwise.                                                                                                       |
| `amount`           | Kronor and ore with two decimals and a full stop, e.g. `10351.50`. The amount as it was billed, frozen on the row: a rate corrected afterwards does not change what was sent. |
| `paymentReference` | The nine digits above.                                                                                                                                                        |
| `dueOn`            | "YYYY-MM-DD". On every row rather than in a header, so a row read into another system carries the date with it.                                                               |

### Who the notice names

The **tenant-owners** (bostadsrattshavare) holding the apartment when the period
closed, read from the member register rather than copied onto the notice. A
partner, an adult child or a tenant living there holds none of the arsavgift -
BRL 7 kap. 14 § puts it on the member - and so is not named.

A holder with **protected personal data** is withheld, and the whole household's
names go with them: naming the others on a flat of two is naming the household.
The apartment stays on the row either way. This is the debiting list's own
masking rule read from the other end - there the person is the charged party and
their apartment is withheld; here the apartment is the party and cannot be
withheld without emptying the row, so it is the name that goes. What protection
exists to withhold is the link between a name and a door.

## The due date

The board states it and **Open BRF computes nothing from it.** No Swedish statute
sets a forfallodag for an arsavgift; BRL 7 kap. 15 § governs only where an avgift
is paid and when it counts as received.

The date matters more than anywhere else in this product, which is exactly why
nothing reads it. BRL 7 kap. 18 § makes an arsavgift unpaid more than a week
after the forfallodag a ground for forverkande of the nyttjanderatt, with no
anmaning required, and 7 kap. 23 § then gives three weeks from a served notice
plus a message to socialnamnden. A platform that counted those days would be
running a forfeiture procedure on the association's behalf. Acting on a missed
due date is the board's own business with its own members, taken with whatever
advice it takes.

## Correcting a notice

**A notice is never edited.** A run and its notices are rakenskapsinformation
(bokforingslagen 1 kap. 2 § 9, through 5 kap. 6-7 §§), and 7 kap. 1 § forbids
altering what is preserved; 5 kap. 9 § requires a rattelse to say when it was
made and by whom. So a correction is a new act that records the correction,
recorded wherever the association keeps its books.

A fee rate a run has already billed from cannot be removed either, for the same
reason: it is that money's basis. A rate that is merely out of date is not
removed at all - recording the next one closes it, and the closed row is what
says what the apartment paid until then.

## How long it is kept

Through the seventh year after the end of the calendar year in which the
association's financial year ended (bokforingslagen 7 kap. 2 §). The financial
year is the one recorded in the settings; on a brutet rakenskapsar that is a full
year later than the notice's own calendar year would suggest, for the part of the
year before it closes.

A nightly purge erases the notices and the run once nothing of it is left, unless
a legal hold stands against anybody who has ever held a residency in the
apartment. A fee rate still in force is never erased at any age: no preservation
period has run out on a fact that is still true.
