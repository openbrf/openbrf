---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

The board can hand whoever keeps the association's books one file with the
period's fees and charges in it.

Until now the two halves of the association's money left in two documents: the
debiting list for the charges and the notice document for the fees. The
accounting basis is both of them for a period the board states, with a column
contract published in `docs/accounting-basis-contract.md` so a mapping into the
accounting program is written once and then left alone. It is offered from the
fee screen and from the charge screen alike, because a board member looking for
it should not have to know which half it was filed under.

A charge belongs to the day it is dated. A notification run belongs to the
period its own period opens in and is carried whole: what is billed to an
apartment for a quarter has no exact part, and this product refuses to apportion an amount
rather than rounding one. Over consecutive periods that means every run lands in
exactly one file - never counted twice, never falling between two.

There is no SIE file and none is planned. The contract document records what one
would have cost, so that whoever revisits the question has the argument rather
than having to rediscover it: the transactions file type would have fitted a
platform with no ledger, and what it asks for is a legacy code page transcode, a
quoting rule of its own and a writer nobody has written for this language -
against a bookkeeper mapping eleven columns once.

The fee half of the file names nobody, and that is deliberate. The notice
document withholds a protected household's names and prints their apartment,
while the debiting list prints a protected person's name and withholds their
apartment. A file carrying both would say, of one apartment, that its holders
are withheld and, of one person, that their apartment is - and a reader holding
the two rows could put the name back against the door. So the file withholds in
one direction only, and a charge on a protected member names them and withholds
their apartment exactly as the debiting list already does.

The file carries no account numbers, no vouchers and no balances, and says
nothing about payment: Open BRF holds the basis and the accounting system holds
the debt. Producing it is an audited disclosure - a copy of named apartments'
and named people's money leaving the association - so it happens when somebody
asks for it rather than when a page is opened, and the entry it writes carries
the period and nothing that was in the file. Whoever asks has to hold both
halves themselves: one seat that may manage the fees and may manage the charges,
and not two seats between them.

Every file this product hands out is also safer to open. A cell beginning with
an equals sign, a plus, a minus, an at sign, a tab or a carriage return is what
a spreadsheet runs as a formula rather than showing as text, and the free-text
columns in these files are what a board typed - a charge's reason, a creditor's
name. Such a cell is now prefixed with an apostrophe, which every spreadsheet
reads as "what follows is text". Amounts are left exactly as they are, minus
sign and all, because a figure turned into text is a worse fault than the one
the prefix is for. This reaches the debiting list, the fee notices, the member
import template and the file for the cooperative housing register as well as
the new one.
