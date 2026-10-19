# ADR 0029: A debiting list for a joint facility association

Date: 2026-10-19

## Status

Accepted. Open BRF does not issue a joint facility association's debiting list.
The board chose option A below on 2026-10-19.

## Context

`ROADMAP.md` kept an unticked box for a debiting list for a joint facility
association (samfällighetsförening), "a separate artifact for a separate legal
person, governed by Lag (1973:1150) om förvaltning av samfälligheter 42 §".
[ADR 0011](0011-fees-and-notices.md) kept it out of the fee work for the same
reason: a bostadsrättsförening is an ekonomisk förening, nowhere brought inside
that act, and a cooperative that is a delägare in a joint facility receives an
assessment as a cost rather than issuing one. The box named the statute. It
did not say who on an instance would issue the list, or for whom.

### What the statute asks of the list

Lag (1973:1150) om förvaltning av samfälligheter (SFL):

- **42 §**: "Om ej annat föreskrives i stadgarna, uttaxeras medlemmarnas bidrag
  genom att styrelsen upprättar och på föreningsstämma framlägger
  debiteringslängd. I debiteringslängden anges det belopp som uttaxeras, vad som
  belöper på varje medlem och när betalning skall ske. I fall som avses i 41 §
  andra stycket redovisas varje verksamhetsgren för sig i debiteringslängden."
- **41 §**: before an assessment, the board draws up an utgifts- och inkomststat
  for the general meeting to approve. Where the association runs separate branches of
  activity (verksamhetsgrenar), each branch is budgeted on its own, and costs
  common to several are divided between them as is reasonable.
- **46 §**: a member who thinks an assessment breaks the act, the bylaws or a
  general meeting decision may sue the association for correction in the mark- och
  miljödomstol "inom fyra veckor från den dag då debiteringslängden framlades på
  föreningsstämma". An amount debited and fallen due may be collected under
  utsökningsbalken as if a final judgment had ordered it, unless the court
  orders otherwise. So the list is the basis for enforcement, not a spreadsheet.
- **44 §**: when a delägarfastighet changes hands other than by forced auction
  sale, the new and the former owner are jointly liable for unpaid amounts
  already assessed on the former owner under 42 and 43 §§. That leaves out
  amounts that fell due more than a year before the agreed possession date. An
  amount that falls due after that date keeps its later due date; otherwise the
  new owner is treated as owing it from the possession date. The debt follows
  the property, so the list has to name the property and not only its owner.
- **43 §**: where the funds cannot meet a debt that has fallen due, the board
  must promptly draw up a special debiting list. The board members are jointly
  liable if they do not.
- **45 §**: money belonging to one branch of activity may not be used for
  another branch or mixed with its money.

What falls on each member is not set by SFL. It comes from the share figures
(andelstal) the lantmäteri förrättning fixed for each participating property.
Anläggningslag (1973:1149) 15 § fixes them separately for the facility's
construction (utförande) and its running (drift). 24 § lets the anläggningsbeslut
state them. 43 a § lets a general meeting change them by two thirds of the votes cast,
taking effect when the lantmäteri authority approves. 24 a § can let the board
change them when a property's use changes for good. 35 § lets a new förrättning
reconsider them. A share figure is a dated fact about a property, held per
branch of activity. It is not a single number per member.

### What an instance is today

One instance is one association (decision #28 in `PRODUCT.md`), and that
association is a bostadsrättsförening: `Association` is a singleton (`id = 1`),
and its members hold bostadsrätter in apartments. The registers, transfers,
fees and the Lantmäteriet reporting are all bostadsrättslagen's. None of what
the list needs exists:

- the members of a joint facility association are the owners of its
  delägarfastigheter, mostly people who live elsewhere and have no residency,
  apartment or account on the instance;
- there is no participating property, no share figure per branch of activity
  and no branch of activity;
- `GLOSSARY.md` already uses **andelstal** for the apartment's share of the
  cooperative, and says nothing in Open BRF works a fee out from it. The
  facility's share figure is another figure under the same word;
- `GLOSSARY.md` already uses **debiting list** for the export of charge basis to
  the economic manager. That list is not the statutory one, and the glossary
  entry says so.

## Options considered

### A. Nobody: this stays outside Open BRF

The roadmap box becomes a stated non-goal and the reason moves into
`ROADMAP.md` and `GLOSSARY.md`. A cooperative that is a delägare books its
assessment as a cost, the same way it books any other invoice. This adds no
data, no capability and no access path.

### B. A cooperative's instance also runs a joint facility association

This fits where the cooperative's board also sits as the joint facility
association's board, which is common for a shared garage or courtyard with the
neighbouring properties. The instance then holds a second legal person: its
organisation number, its participating properties, their share figures per
branch of activity and their owners. This breaks "one instance per association"
(#28). It also brings in people the instance has no other reason to hold: the
owners of the neighbouring properties. That is a new category of personal data,
a new record of processing activity and a new capability, so it is not
security-neutral.

### C. An instance is one kind or the other

First boot asks whether the association is a bostadsrättsförening or a
samfällighetsförening, and a joint facility association gets its own instance,
members and register. This keeps #28. Inside such an instance the owners are its
members and fall under the access model members already have. But every
bostadsrättslagen screen (registers, transfers, liens, fees, Lantmäteriet
reporting) then has to know which kind it runs in, and the product has a second
kind of customer. That is a change to `PRODUCT.md`, not a roadmap item.

### D. A plugin

The list, the participating properties and the share figures live in a plugin
built against the public API, as the paid modules are. Core is unchanged. The
plugin holds the same new data as B, under its own declared permissions.

## Decision

**A.** Open BRF does not issue the statutory debiting list of a
samfällighetsförening, and the roadmap states it as a non-goal.

- The pilot is a bostadsrättsförening, and nothing in the 1.0 acceptance needs a
  cooperative to issue an assessment.
- A is the only option that adds no personal data, no capability and no access
  path.
- B goes against the instance model and brings in the owners of neighbouring
  properties. D puts statutory content behind a plugin boundary and holds the
  same data as B, for no gain.
- If joint facility associations are ever to be users in their own right, C is
  the honest way to do it, and it starts as a change to `PRODUCT.md` with its
  own plan, not as this roadmap item.

Two further questions were put to the board: whether a built list would be in
1.0, and whether it would support only the statutory default of 42 § (a
debiting list apportioned by share figures) and not another method the bylaws
might prescribe. Both apply only to B, C and D, so A leaves them unanswered.

## If this is reopened

These rules were written for B, C and D before the board decided. They are not
decided. They are kept so that a later record can start from them instead of
from nothing, and they would be reviewed again then.

### The list names the property and its owner, per branch of activity

A row is a participating property, named by its property designation (fastighetsbeteckning). Its
owner, as recorded on the day the list is presented, is named beside it. The
debt follows the property (44 §), and a share figure belongs to the property.
Each branch of activity is a section of its own, with its own amount assessed
(42 § sista meningen, 45 §).

### Apportionment: exact to the öre, largest remainder

For each branch of activity, the board enters the amount assessed in whole öre.
Each participating property's share figure for that branch is taken as recorded
on the date of the general meeting that approved the assessment. Share figures are stored
as exact decimals, never floating point. Then:

1. Each property's exact part is `amount × figure ÷ sum of figures`. The divisor
   is the sum of the figures of the properties taking part in that branch, not a
   fixed 1 or 100, because a förrättning's figures need not add up to either.
2. Each part is rounded down to the öre.
3. The öre left over, at most one fewer than the number of properties, go one
   at a time to the properties with the largest remainders. A tie goes to the
   property whose designation sorts first, so the same input always gives the
   same list.
4. The parts add up to the amount assessed exactly. A property with a figure of
   0 for a branch gets 0 and still appears on the list, so the list shows that it
   was considered.

Share figures and amounts are never stored as a float, and the computation runs
on integers (öre and scaled decimals).

### When payment is due: one or more instalments

The general meeting may set one due date or several. Each instalment is a fraction of the
assessment. Each property's part is split across the instalments by the same
largest-remainder rule, inside that property's part, so the instalments of a
property add up to its part exactly. "När betalning skall ske" is answered for
every row.

### A presented list is never edited

A list is a draft until the board records the date it was presented at the
general meeting. From then on it is frozen. That date starts the four weeks of 46 §, and
the list shows when they end. A correction, whether ordered by a court under
46 § or found by the board, is a new list that names the one it supersedes. The
old list is not rewritten. A special list under 43 § is a list with its own
reason, built by the same rules.

### Naming

The statutory artifact is called the **assessment roll** in code and in the
English interface (`AssessmentRoll`), and debiteringslängd in Swedish. The
facility's share figure is the **property's share figure** (`PropertyShare`).
This keeps both apart from the charges module's debiting list and from the
apartment's andelstal. `GLOSSARY.md` gets both rows in the pull request that
adds the model.

## Consequences

- `ROADMAP.md` drops the unticked box. The entry now says the list is not
  planned, why, and points here.
- `GLOSSARY.md`'s debiting list entry says Open BRF does not produce the
  statutory list.
- No code, data or capability is added. ADR 0011's paragraph on the
  samfällighet debiting list stays true for a bostadsrättsförening.
- A cooperative that is a delägare in a joint facility association records the
  assessment it receives as a cost, outside Open BRF or in whatever keeps its
  books.

## Revisit triggers

- A real joint facility association asks to run on Open BRF. That is option C,
  and it starts with `PRODUCT.md`, not with the roadmap.
- The pilot association turns out to be the operator of a joint facility
  association whose list it now keeps by hand.
- Ekonomi Pro grows to book incoming assessments for a cooperative that is a
  delägare. That is a cost and belongs there, not here.
