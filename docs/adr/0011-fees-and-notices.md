# ADR 0011: Fees, their notices, and what a fee is calculated from

Date: 2026-09-18

## Status

Accepted

## Context

`ROADMAP.md` put fee notices in the free core. The charges module, which is the
nearest thing already built, refuses a row dated into the future by validation
rather than by policy: `readPastDate` throws `date-in-the-future` for any
`chargedOn` after today, and `member-charge.error.ts` gives the reason in as many
words - "a sum dated into next month is either a mistake or the recurring charge
that belongs to the paid module. Refusing it here is what keeps this table the
basis rather than a schedule."

An arsavgift is by definition recurring. Read together, the roadmap and the
charges module appear to contradict each other.

They do not, and seeing why is what this decision rests on. Every sentence the
charges module writes about recurrence is about a _debitering_: a one-off cost
put on a named member or apartment. `GLOSSARY.md` has always kept the two apart,
and so does the statute. BRL 7 kap. 14 § names the arsavgift as the fee "for den
lopande verksamheten" and lists upplatelseavgift, overlatelseavgift and avgift
for andrahandsupplatelse as the separate, bylaws-conditional ones; BRL 9 kap.
13 § makes fixing the avgifter the board's standing task rather than an event.

Three things were missing before a fee could exist at all. `Apartment` carried a
participation share and an initial share capital that nothing wrote. `Association`
held no financial year, no bankgiro and no plusgiro. And nothing in the web
application formatted money.

## Decision

### A fee is its own model, and `MemberCharge` is not touched

`apps/api/src/fees/` holds a table, a capability, a retention window and a screen
of its own, and the word "charge" appears nowhere in it. Nothing in
`apps/api/src/charges/` changes but one clause of a doc comment that read as
though recurrence as such were paid.

A rate dated forward is accepted here and a charge dated forward stays refused
there. That is the whole difference, and it is a difference about what the two
rows claim: a rate dated forward is the board recording a decision it has taken
about a rate, while a charge dated forward is a claim that something happened
which has not. Stating it here is what lets `member-charge.error.ts` stand
unamended.

The alternative - relaxing `readPastDate` and adding a recurrence rule to
`MemberCharge` - was rejected on the module's own terms. It would put a standing
rate inside a table whose entire argument is that it holds one-off basis, and it
would make the refusal that protects that argument conditional.

### The board states each apartment's amount, and the platform derives nothing

The word _andelstal_ does not occur anywhere in bostadsrattslagen. What the
statute requires is that the stadgar state the basis - BRL 9 kap. 5 § forsta
stycket 5, "grunderna for berakning av arsavgift, overlatelseavgift och avgift
for andrahandsupplatelse" - and that the board then fixes the amounts under
9 kap. 13 §. Apportioning by andelstal is near-universal practice and it is a
bylaws construct; associations exist that apportion by area or by a fixed table.

So the apartment register records the participation share for its own sake, and
the fee screen offers it as an aid: enter a yearly total, see what each
apartment's share would give per month, accept or overwrite each figure. The aid
recomputes on demand, stores nothing, and no total is stored anywhere. What is
stored is the amount the board stated.

A platform that computed the fee from the share would be enforcing one
association's bylaws as if it were statute. That is the same argument
`member-charges.controller.ts` already makes about VAT rates: a board told to
apply a rate this file had not heard of would be refused by the platform rather
than by the law.

### The amount is monthly, because the period arithmetic has to be exact

A rate states what an apartment pays for one calendar month, and a notification
run multiplies it by the months in the period. That is exact in ore. A yearly
figure divided by twelve is not - 10000.00 across twelve months has no answer
that is a sum of kronor and ore - and this product refuses a malformed amount
rather than rounding one, everywhere else and here. A period that is not whole
calendar months is refused for the same reason: a part month would need a
division of kronor by days.

The aid divides, and says what the division could not place rather than
distributing it onto somebody's fee.

### The notice is produced, not sent

The run and its rows are recorded, and the document is produced from the recorded
rows. Two things follow from recording rather than producing on the fly, which is
what the debiting list does. A payment reference quoted back over the telephone
has to be findable. And the board has to be able to say what it billed, which a
figure recomputed from rates that have since been corrected could not answer.

Sending is core rather than paid - the published boundary is delivery into
another system, and a member's notice reaching a member is not that - but it is
its own act with its own claim-once problem, and it lands after a produced notice
has been read by a real board. There is no delivery state on a row to be left
half-true in the meantime.

A period may be issued once and two runs may not overlap. A month billed twice
would give the association two answers to what it asked for and two sets of
payment references for one month's money. That rule is also what makes the
payment reference unique with no counter: the reference carries the month the
period opens in, and no two runs can open in the same month.

### Nothing computes from the due date

No Swedish statute sets a forfallodag for an arsavgift; BRL 7 kap. 15 § governs
only where an avgift is paid. The date matters more here than anywhere else in
the product, and that is exactly why nothing reads it: BRL 7 kap. 18 § makes an
arsavgift unpaid more than a week after the forfallodag a ground for forverkande
of the nyttjanderatt, with no anmaning, and 7 kap. 23 § then requires a served
notice and a message to socialnamnden before anybody can be made to leave. A
platform that counted those days would be running a forfeiture procedure.

The due date is a field on a document, bounded to the period it bills.

### No payment, no balance, no status

The rule `debiting-list.ts` states three times extends to the fee unchanged. A
notice says what is due; nothing in Open BRF ever says whether it arrived. The
pressure to add it comes from the notice screen, where the absence is most
visible, and the answer is the one the charges module already gives: the
accounting system settles the debt, and a second answer to whether something is
paid is worse than none.

### The masking rule is the debiting list's, read from the other end

The debiting list names a person and withholds a protected person's apartment,
because there the person is the charged party and the apartment is the detail. A
notice is the other shape: the fee is fixed per apartment under BRL 9 kap. 13 §,
so the apartment is the party and withholding it would empty the row. What
protection exists to withhold is the link between a name and a door, so on this
document it is the name that goes - and the row says so rather than leaving the
cell blank.

One protected holder withholds the whole household's names rather than their own.
Naming the others on a flat of two is naming the household, and the link would be
back in place.

### The association records its financial year, and it corrects the charge purge

`computeMemberChargePurgeDate` anchored on the charge's own calendar year.
Bokforingslagen (1999:1078) 7 kap. 2 § preserves rakenskapsinformation "fram till
och med det sjunde aret efter utgangen av det kalenderar da rakenskapsaret
avslutades" - the calendar year the _financial year_ ended in, which for an
association running the calendar year is the same sentence and for one running a
brutet rakenskapsar is not.

Take a year running from the 1st of May. A charge dated in June 2026 falls in the
year that ends on the 30th of April 2027 and is preserved from the end of 2027; a
charge dated in March 2026 falls in the year that ended that April and is
preserved from the end of 2026. Two charges eleven weeks apart, a year apart in
when they may be erased. The module comment conceded "a few months longer or
shorter"; the real drift is a full year, and it is only ever in one direction.

`Association.financialYearStartMonth` is therefore read by both retention
windows. Three properties make correcting a shipped window safe:

- The default is January, which is what every instance recorded before the column
  existed had assumed. On it both functions compute exactly what they computed
  before.
- The end year of a financial year containing a day is never before that day's own
  calendar year, so the correction moves erasure dates later and never earlier. No
  date already stated to a named person on a data subject access report is brought
  forward.
- The arithmetic lives in one module, `retention/financial-year.ts`, and its spec
  runs the two functions against each other. A window read from two ends that
  disagreed would erase on a day the product had not stated.

The setting is an administrator's, beside the retention policy, because it is
instance configuration rather than something the association charges.

## Consequences

An `AuditAction` value is a six-file change plus a standalone migration, and this
adds six of them: the settings write, the register write, recording and removing
a rate, issuing a run and producing its document. None of them carries a figure.
The log is exempt from every purge, so an amount copied into an entry would be a
permanent record of what one household pays inside the entry that merely says a
rate was recorded.

`AssociationFacts.feePolicy` and `feeIncludes` keep their own answer. They are
prose the board writes for a broker, on a model whose doc comment forbids
statutory data being derived from it. The fee rate never populates them and they
never populate the fee, which is the same deliberate duplication
`Association.propertyDesignation` argues for: a broker asks a question the
register does not answer, and a field serving both would have two answers and no
way to say which it meant.

Not every fee is exempt from value added tax. ML 10 kap. 35 § exempts the
upplatelse, but 10 kap. 36 § takes parking spaces, storage boxes and advertising
space back out of the exemption. So a rate carries a VAT treatment from the first
migration, mirroring `MemberChargeVatTreatment`, even though the common case is
exempt. A taxable line does need a real faktura, which this product does not
produce, and `docs/fee-notice-contract.md` says so rather than pretending.

An OCR format is the association's agreement with its own bank. Open BRF
publishes the rule it computes by and does not promise the shape is the one the
bank expects; the contract document says which part is the association's to
check. The risk if that is left implicit is a board sending four hundred notices
carrying a reference its bank rejects.

The samfallighet debiting list stays out. A samfallighetsforening is a different
legal person under Lag (1973:1150), a bostadsrattsforening is nowhere brought
inside that act, and its debiteringslangd is an enforcement title under 46 §
rather than a spreadsheet. `ROADMAP.md` keeps an unticked box saying so.
