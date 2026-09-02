# The initial supply to the cooperative housing register

What Open BRF produces for the supply a housing cooperative owes Lantmäteriet by
31 December 2027 under Lag (2026:485) 3 §, and exactly what each column of that
file means.

## This shape is Open BRF's own, and not Lantmäteriet's

Stated first because everything below depends on it.

**Lantmäteriet has not published a technical interface for the
bostadsrättsregister.** Förordning (2026:898) 2 kap. 2 § permits an anmälan to be
transferred electronically "enligt föreskrifter som Lantmäteriet får meddela",
and 5 kap. 1 and 2 §§ together with övergångsbestämmelse 3 leave the form of both
the anmälan and the initial supply to föreskrifter that do not exist yet. The
register itself is still being built: Lag (2026:485) 2 § puts Lantmäteriet in
charge of the build and 10 § has it tell the government when the register is
ready to be taken into use.

So the file described here is a delimited file of Open BRF's own design. **Do not
read it as a Lantmäteriet format, and do not send it to Lantmäteriet as though it
were one.** It exists so that:

- an association can see, check and sign off what it is going to supply, well
  before the deadline;
- the data is assembled once, from the register the association already keeps,
  rather than typed a second time into whatever form is eventually prescribed;
- transforming it into the prescribed form, when there is one, is a mapping
  against a stable contract instead of a second reading of the statute.

What is **not** invented here is the content. Förordning (2026:898) 2 kap. 3-7 §§
enumerates the data the register holds, and that förordning's
övergångsbestämmelse 2 narrows the initial duty to a named subset of it. Every
column below is one of those enumerated fields, and the ones that are not say so.

## What the duty covers

Lag (2026:485) 3 §:

> En bostadsrättsförening ska senast den 31 december 2027 till Lantmäteriet lämna
> de uppgifter som bostadsrättsregistret ska innehålla i fråga om
> bostadsrättslägenheten, bostadsrättsföreningen, bostadsrättshavaren,
> pantsättningar och anteckningar.

Förordning (2026:898) övergångsbestämmelse 2 narrows that to the fields in
2 kap. 3 § första stycket 1-4, 6 and 8; 4 §; 5 § första stycket 1-4, 6 and 7 and
andra stycket; 6 § första stycket 1-3, 5 and 6; and 7 § - and only so far as the
association "är skyldig att ha antecknade eller har tillgång till" them.

Two consequences worth naming.

**Lien notes are inside the supply duty although they open no reporting
obligation.** The two are different duties and the glossary keeps them apart. A
reporting obligation (anmälningsskyldighet) is the standing per-event duty under
Lag (2026:484) 3 kap., and the one for a pantsättning falls on the panthavare
rather than on the association (3 kap. 5 §, 6 § and 8 §) - which is why
`RegisterReportObligation` has no lien kind and why a lien note opens nothing in
that ledger. The supply duty (uppgiftsskyldighet) is the association's own, it
names pantsättningar explicitly, and the consequence of leaving one out is not
administrative: Lag (2026:485) 11 § has a
panträtt with sakrättsligt skydd from before the act registered as a noterad
pant when it is supplied, and 13 § makes such a panträtt keep that skydd only if
it reached Lantmäteriet within six months of the act coming into force.

**Anteckningar produce no rows, and that is the duty being met.** Förordning
(2026:898) 2 kap. 7 § lists ten decisions and measures: utmätning, kvarstad,
betalningssäkring, tvångsförsäljning, exekutiv försäljning, förvar, a suit about
hävning or bättre rätt, a refused membership referred to hyresnämnden, unpaid
fees under BRL 7 kap. 31 §, and a decision under BRL 9 kap. 16 § första stycket 4. Open BRF records none of them, and none is a record bostadsrättslagen requires
the association to keep, so övergångsbestämmelse 2 b) does not reach them.

Lag (2026:485) 6 § also drops the duty entirely for data that can instead be
taken from fastighetsregistret or lägenhetsregistret. Several of the fields
listed as not held below are of exactly that kind.

## The file

A semicolon-delimited UTF-8 file with a byte order mark, written by the same
writer as the member import template: a Swedish spreadsheet uses the semicolon as
its list separator, and an unmarked UTF-8 file is read as the local code page and
turns every Swedish vowel into a pair of symbols. Rows end with CRLF. A cell
containing a semicolon, a quotation mark or a line break is quoted, and an inner
quotation mark is doubled.

The first line is the header, and it is the column list verbatim. Every row has a
cell for every column.

### Rows are typed

The duty covers five kinds of thing at once and they do not have one shape. An
apartment has one holder or several, each with a personal identity number of
their own; a lien note belongs to an apartment and not to a holder; the
association's own fields are stated once for the whole file. A single flat row
per apartment would have to either repeat a holder's columns a fixed number of
times, silently dropping the third co-holder, or leave the lien notes out.

So the first column names what the row is about, and a row fills the columns
belonging to its kind and leaves the rest empty.

| Record type   | How many                         | What it is                            |
| ------------- | -------------------------------- | ------------------------------------- |
| `ASSOCIATION` | one                              | The bostadsrättsförening (2 kap. 4 §) |
| `APARTMENT`   | one per bostadsrätt              | The bostadsrättslägenhet (2 kap. 3 §) |
| `HOLDER`      | one per current holder of each   | The bostadsrättshavare (2 kap. 5 §)   |
| `LIEN`        | one per lien note still standing | Pantsättningar (2 kap. 6 §)           |

`HOLDER` and `LIEN` rows point at their `APARTMENT` row through
`apartmentKey`.

Rows come out in a stable order: the association first, then each apartment
followed by its holders and its lien notes, apartments in the order the address book
sorts its entrances and then by apartment number.

### The columns

Statutory references are to Förordning (2026:898) unless stated otherwise.

| Column                           | Filled on                     | Field                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ----------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordType`                     | every row                     | -                        | Open BRF's own. `ASSOCIATION`, `APARTMENT`, `HOLDER` or `LIEN`.                                                                                                                                                                                                                                                                                                                                                                               |
| `apartmentKey`                   | `APARTMENT`, `HOLDER`, `LIEN` | -                        | Open BRF's own. The apartment as street, number and apartment number, which is how the apartment register designates it and is unique within an association. It exists so a holder or a lien note can name the apartment it belongs to; it is **not** the beteckning of 2 kap. 3 § första stycket 1.                                                                                                                                          |
| `associationName`                | `ASSOCIATION`                 | 2 kap. 4 § 1             | Föreningens namn.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `associationOrganizationNumber`  | `ASSOCIATION`                 | 2 kap. 4 § 2             | Föreningens organisationsnummer. Empty where the instance has not recorded one.                                                                                                                                                                                                                                                                                                                                                               |
| `associationPropertyDesignation` | `ASSOCIATION`                 | 2 kap. 4 § andra stycket | Fastighetsbeteckning, from the association's own authoritative record of it and never from the prose published on the broker page. Andra stycket makes this field conditional: it is reported in place of the lagfarts- och tomträttsinnehav of första stycket 4 where the association's buildings stand on land it neither owns nor holds with tomträtt. Open BRF holds the designation and not the innehav, so the file states what it has. |
| `apartmentNumber`                | `APARTMENT`                   | 2 kap. 3 § 1 2           | Lägenhetsnummer enligt 6 § lagen (2006:378) om lägenhetsregister.                                                                                                                                                                                                                                                                                                                                                                             |
| `apartmentAddressStreet`         | `APARTMENT`                   | 2 kap. 3 § 1 3           | Belägenhetsadress, street.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apartmentAddressNumber`         | `APARTMENT`                   | 2 kap. 3 § 1 3           | Belägenhetsadress, number.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apartmentPostalCode`            | `APARTMENT`                   | 2 kap. 3 § 1 3           | Postnummer.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apartmentPostalCity`            | `APARTMENT`                   | 2 kap. 3 § 1 3           | Postort.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `holderName`                     | `HOLDER`                      | 2 kap. 5 § 1 1           | Bostadsrättshavarens namn.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `holderPersonalIdentityNumber`   | `HOLDER`                      | 2 kap. 5 § 1 2           | Personnummer or samordningsnummer, twelve digits and no hyphen. This is the only file Open BRF ever writes a personal identity number into, and producing it is behind its own capability and its own audit entry. Empty where the register holds no number for the holder.                                                                                                                                                                   |
| `holderPostalStreet`             | `HOLDER`                      | 2 kap. 5 § 1 3           | Postadress, street and number. Empty for a holder with skyddade personuppgifter; see below.                                                                                                                                                                                                                                                                                                                                                   |
| `holderPostalCode`               | `HOLDER`                      | 2 kap. 5 § 1 3           | Postadress, postal code.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `holderPostalCity`               | `HOLDER`                      | 2 kap. 5 § 1 3           | Postadress, city.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `holderProtectedPersonalData`    | `HOLDER`                      | -                        | Open BRF's own, `yes` or `no`. It is here because the three columns above it are deliberately empty for such a holder, and an empty address with nothing saying why reads as a register that lost one.                                                                                                                                                                                                                                        |
| `holderHeldFrom`                 | `HOLDER`                      | 2 kap. 5 § 1 6           | Tidpunkten för tillträde av bostadsrätten, as an ISO date.                                                                                                                                                                                                                                                                                                                                                                                    |
| `holderMembershipDecidedOn`      | `HOLDER`                      | 2 kap. 5 § 1 7           | Tidpunkten för beviljande av medlemskap, as an ISO date. Empty where no decision date was recorded, which Lag (2026:484) 3 kap. 3 § andra stycket provides for: an övergång to somebody already a member, or outside the membership requirement, has no decision to date. A **nekande** of membership is not recorded at all; see below.                                                                                                      |
| `lienCreditor`                   | `LIEN`                        | 2 kap. 6 § 1 1           | Panthavarens namn, as the association noted it.                                                                                                                                                                                                                                                                                                                                                                                               |
| `lienNotedOn`                    | `LIEN`                        | -                        | Open BRF's own. The anteckningsdag in the association's own lägenhetsförteckning, which is not itself one of the register's fields but is what shows the lien existed before the act came into force (Lag (2026:485) 11 §).                                                                                                                                                                                                                   |

### When the file is refused rather than produced

Two of the association's own fields are refused on rather than left blank,
because a supply that does not identify the association cannot discharge the
duty at all - and produced anyway it leaves a download to mistake for a completed
one.

- **No association record.** Lag (2026:485) 3 § is a duty on a named
  bostadsrättsförening.
- **No organisationsnummer.** 2 kap. 4 § 2 registers it, övergångsbestämmelse 2
  puts the whole of 4 § inside the initial duty, and 3 kap. 1 § makes it one of
  the sökbegrepp the register is looked up by.

The property designation is deliberately **not** refused on beside them. 4 §
andra stycket makes fastighetsbeteckning conditional - reported in place of the
lagfarts- och tomträttsinnehav only where the association's buildings stand on
land it neither owns nor holds with tomträtt - so an absent one is a truthful
answer where an absent organisationsnummer is not.

### A protected holder's address is not supplied

A person with skyddade personuppgifter has an address the association may not
pass on, and a supply duty is not an exception to that. The file carries their
name and their personal identity number, which are what identify a holder in this
register: 3 kap. 1 § makes name and personnummer the sökbegrepp it is looked up
by, including by an association within its own bestånd. It leaves the three postal
columns empty with `holderProtectedPersonalData` set to `yes` beside them.

The receiving authority is not left without an address: it holds one through
Skatteverket, which is where the protection is administered and where a change of
it is recorded. The alternative address Open BRF keeps for such a person is
deliberately **not** put in its place. It exists so the association can reach
them, and supplying it as the postadress a state register is to hold would be a
statement nobody made.

## What is in the duty and not in the file

Every field below is inside övergångsbestämmelse 2 a) and has no column, because
Open BRF does not hold it. An association that has to supply one takes it from
somewhere else. The list is here so a reader can see what is missing rather than
discover it.

| Field                                                                                                              | Why there is no column                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 kap. 3 § 1 1, föreningens egen beteckning för lägenheten                                                         | Open BRF records one apartment number, the lägenhetsregister one. Andra stycket dispenses with this field where the association's own beteckning is the same as the lägenhetsregister's, and an instance cannot assert that it is.                                                                   |
| 2 kap. 3 § 1 4, antal rum, kökstyp, bostadsarea                                                                    | Not recorded. Lag (2026:485) 6 § drops the duty for data obtainable from lägenhetsregistret, and 6 § lagen (2006:378) is where these live.                                                                                                                                                           |
| 2 kap. 3 § 1 6, whether mark and other utrymmen are included in the upplåtelse                                     | Not recorded. It is a term of the upplåtelseavtal, and Open BRF holds the agreement reference rather than its terms.                                                                                                                                                                                 |
| 2 kap. 3 § 1 8, lokal or bostadslägenhet                                                                           | Not recorded. Open BRF's apartment model does not distinguish the two.                                                                                                                                                                                                                               |
| 2 kap. 4 § 3, föreningens postadress                                                                               | Not recorded. The association singleton carries a name, an organisation number and a property designation, and no postal address of its own.                                                                                                                                                         |
| 2 kap. 4 § 4, lagfarts- och tomträttsinnehav                                                                       | Not recorded. Whether the land is owned or held with tomträtt **is** recorded, as an association fact, which is what makes the conditional case of andra stycket answerable; the innehav itself is not.                                                                                              |
| 2 kap. 4 § 5, 6 and 7, antal byggnader, bostadslägenheter and lokaler                                              | Not recorded, and not derivable. An address in Open BRF is an entrance rather than a building, and lokaler are not distinguished from bostadslägenheter (see 3 § 1 8 above), so counting the apartments would answer a different question from the one asked.                                        |
| 2 kap. 4 § 8, whether the association is in konkurs                                                                | Not recorded.                                                                                                                                                                                                                                                                                        |
| 2 kap. 4 § andra stycket, taxeringsenhetsnummer and fastighetstyp                                                  | Not recorded. Both are named in `GLOSSARY.md` as fields the reporting work has to answer for; fastighetstyp in particular has no unambiguous source, because the nearest statutory classification in fastighetstaxeringslagen (1979:1152) 4 kap. classifies the taxeringsenhet and not the property. |
| 2 kap. 5 § 1 4, den andel av bostadsrätten en bostadsrättshavare innehar                                           | Not recorded. Open BRF holds andelstal, the apartment's share of the association used to allocate fees, which is a different quantity from a co-holder's share of one bostadsrätt.                                                                                                                   |
| 2 kap. 5 § 1 7, tidpunkten för **nekande** av medlemskap                                                           | Not recorded. Open BRF records the day a membership decision was taken as the day a reporting window opened; a refusal opens no window and has no field.                                                                                                                                             |
| 2 kap. 5 § andra stycket, civilstånd and makes personnummer, namn, postadress or the date a marriage was dissolved | Not recorded, and deliberately: the platform holds no marital status and no data about a member's spouse who is not themselves a resident.                                                                                                                                                           |
| 2 kap. 6 § 1 2 and 3, panthavarens personnummer or organisationsnummer and postadress                              | Not recorded. A lien note carries a creditor as the association wrote it and no identifier for them.                                                                                                                                                                                                 |
| 2 kap. 6 § 1 5, pantens prioritetsnummer                                                                           | Not recorded.                                                                                                                                                                                                                                                                                        |
| 2 kap. 6 § 1 6, whether only a share of the bostadsrätt is pledged                                                 | Not recorded.                                                                                                                                                                                                                                                                                        |
| 2 kap. 7 §, anteckningar                                                                                           | None of the ten is recorded. See "What the duty covers" above.                                                                                                                                                                                                                                       |

## What the file does not represent

- **Earlier holders.** The file states who holds each bostadsrätt now. Uppgifter
  om äldre förhållanden (2 kap. 11 §) are the register's own, built from the
  reports it receives, and this file is the first of those rather than a history.
- **Terminations.** A bostadsrätt that has ceased is avregistrerad by
  Lantmäteriet on a report under Lag (2026:484) 3 kap. 4 § (2 kap. 10 §), which
  is the standing per-event duty the obligation ledger carries. An apartment
  whose tenant-ownership has ceased appears here with no `HOLDER` row.
- **A released lien note.** A pantsättning that no longer applies is deregistered by
  the panthavare (Lag (2026:484) 3 kap. 8 §), and a released note had no
  sakrättsligt skydd for Lag (2026:485) 11 § to preserve.

## Where the contract lives in the code

`apps/api/src/registers/initial-supply-file.ts` holds the column list and the
writer. The column list there and the column table above are checked against each
other by `initial-supply-file.spec.ts`, which reads this document rather than
restating it: a column added to one alone fails that test.
