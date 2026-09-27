# ADR 0018: The record of processing activities decides what the portability export carries

Date: 2026-09-25

## Status

Accepted

## Context

Three documents describe the personal data one instance holds, and each answers
a different article of the GDPR:

- the record of processing activities (registerförteckning, art. 30), seeded
  from `SEED_KEYS` in `apps/api/src/data-protection/processing-activity-seed.ts`,
  one row per processing with its purpose, basis, subjects, categories,
  recipients and retention;
- the data subject access report (registerutdrag, art. 15),
  `DataSubjectReport` in `apps/api/src/retention/data-subject-report.ts`, one
  section per store of personal data about a person;
- the portability export (dataportabilitet, art. 20), a projection of the
  access report in `apps/api/src/data-protection/data-portability.ts`.

The record's list and the export's per-section decisions were both kept by
hand, and nothing tied either to the access report. The seed file's own rule -
adding a table that holds personal data means adding a row - was enforced by
nobody. The board mailbox, subletting applications, key orders, charges and
comments on news each added a section to the access report and no row to the
record, and positions of trust and system roles, legal holds, requests about
own data and the breach register had never had one.

The export's header, the glossary, the roadmap and the profile all say it
carries what the person gave under the membership contract or a consent. Art.
20(1)(a) says the same: the right applies where "the processing is based on
consent pursuant to point (a) of Article 6(1) or point (a) of Article 9(2) or on
a contract pursuant to point (b) of Article 6(1)". The export nevertheless
carried the issue reports, the document archive, comments on news, the chat, the
chat reports and requests about own data, whose processing rests on the
association's legitimate interest or on a legal obligation. ADR 0017 left the
apartment binder out of the export on exactly that ground and named the archive's
documents as the inconsistency it did not copy.

## Decision

### One typed map from every section of the access report to a row

`apps/api/src/data-protection/section-processing.ts` maps every key of
`DataSubjectReport` either to the seed key of the row that covers it, with what
the export does with the section, or to a part of the document: the date it was
produced on, the controller, and the retention answer derived from sections
that have rows of their own.

The map is declared `satisfies Record<keyof DataSubjectReport,
SectionProcessing>`, so a key added to the report without an entry, an entry
naming a key the report does not have, and a row that is not a seed key all fail
to compile. `section-processing.spec.ts` holds what the compiler cannot: that
only those three keys are parts of the document, and that every row of the
record is reached by a section or listed with a reason - a view of another row,
a table keyed to no person, or a table the access report does not carry. That
list is checked in both directions, so an entry nothing uses cannot be
inherited. The access report's integration suite checks that the report the
route sends has exactly the map's keys.

A typed map rather than a walk of the source. The report's sections are an
interface the compiler already enumerates; the walk `erasure-domains.spec.ts`
does is for a fact only visible in what code does, which jobs read granted
erasure requests, and which section covers which processing is not such a fact.

The access report's audit entry reads its section list from the map, in the
interface's order, so its content does not change and a new section cannot be
left out of it.

### The export carries what the map marks carried

Each entry with a row states one of three things:

- `carried`: the row rests on consent or the contract, and the section is what
  the person provided;
- `otherBasis`: the row rests on neither, so art. 20(1)(a) does not reach it;
- `notProvided`: the row rests on one of them, and the section is still the
  association's own account rather than what the person provided - art. 20(1)'s
  first bound, "which he or she has provided", judged per section. The account's
  creation time and second-factor state are the one such section today.

A section is `otherBasis` exactly when its row rests on neither consent nor
contract, and the export's spec asserts it for every entry. The export's type
extends `Record<PortableSection, unknown>`, so a carried section the type
forgets fails to compile, and the spec holds the projection to exactly the
carried sections. What the export leaves out stays on the access report, which
is unchanged.

The basis is the product's statement of it, the seed's `SHAPES`, and not an
instance's copy of the row. A board that edits the basis on its own record
changes its record, not what the product exports.

A row counts by the basis it records. The address book rests on the contract for
members and names legitimate interest for other residents in its note; `person`
and `residencies` are carried for everybody. Handing a person their own contact
details and residencies discloses nothing to anybody else, and they are the
same data art. 15 hands them. Narrowing per person would make the file depend on
role history, which changes per residency.

### The nine rows

- **`boardMailbox`: legitimate interest, art. 6(1)(f).** Dealing with what the
  association is asked and answering whoever wrote. No statute obliges it to
  keep a shared inbox, and most correspondents have no contract with it. A
  letter may carry health data its writer chose to put in it (art. 9).
- **`subletApplications`: contract, art. 6(1)(b).** BRL 7 kap. 10 §: a
  bostadsrättshavare may sublet "endast om styrelsen ger sitt samtycke". The
  application and the answer are that consent asked for and given or refused, a
  step in the tenure the member holds. 10 § conditions the holder's right and
  puts no duty on the association to process anything, which art. 6(3) would
  require for (c). Kept two years past the letting because subletting without
  consent is a ground for forfeiture under 7 kap. 18 § första stycket 2.
- **`keyOrders`: contract, art. 6(1)(b).** A service a household asks the
  association for, on the bookings and events precedent. No statute.
- **`memberCharges`: legal obligation, art. 6(1)(c).** A charge records a
  receivable arising, an affärshändelse (bokföringslagen (1999:1078) 1 kap. 2 §
  första stycket 7); every affärshändelse needs a verifikation (5 kap. 6 §);
  what documents it is räkenskapsinformation (1 kap. 2 § första stycket 9),
  kept through the seventh year after the calendar year the financial year
  ended (7 kap. 2 §); the association is bokföringsskyldig (2 kap. 1 §). The
  fees row takes the same position.
- **`newsComments`: legitimate interest, art. 6(1)(f).** Letting the house talk
  under what the board publishes. Not objectively necessary to the membership;
  the chat, the nearest processing, rests on the same basis.
- **`boardPositionsAndSystemRoles`: legitimate interest, art. 6(1)(f).**
  Knowing who holds a seat or a role, and being able to say afterwards who
  answered for the association when. The property manager holding a system role
  is party to no contract with the association.
- **`dataSubjectRequests`: legal obligation, art. 6(1)(c).** GDPR art.
  12(3)-(4), 17, 18 and 21, and art. 5(2): Union law, which art. 6(3)(a)
  accepts.
- **`personalDataBreaches`: legal obligation, art. 6(1)(c).** GDPR art. 33(5),
  "The controller shall document any personal data breaches", with the
  decisions under art. 33(1) and 34(1).
- **`legalHolds`: legitimate interest, art. 6(1)(f).** Establishing, exercising
  or defending a legal claim, or answering an authority's request. Art.
  17(3)(b) and (e) disapply erasure rather than supplying a basis.

The three data protection processings are three rows rather than one with two
bases, which the record exists to keep apart. Processing personal data to comply
with the GDPR is processing (art. 4(2)), and art. 30(1) asks for all of it.

### The mailbox is a recipient

The board mailbox collects its letters over POP3 from an account at the
association's mail provider, which holds every letter on the association's
behalf; the instance never deletes one there. Art. 30(1)(d) asks for the
recipients, and a processor is one (art. 4(9), "whether a third party or not").
The processor register reads the same facts as the record, and its rule is that
a recipient that exists is listed. So the fixed processor key `mailbox`, of kind
`MAILBOX`, is listed once the board mailbox is configured - address, host, user
and password all present, one test shared by the collector, the settings screen
and the facts reader - with no suggested classification: an association may run
its own mail server, which is no processor.

### What the new rows made untrue in the existing ones

- The sentence that people with protected personal data are masked everywhere
  was added to every row holding names. Whoever writes to the board, uses the
  contact form or asks for an account is shown as they wrote; those three rows
  now say that instead.
- The fees row named no recipient although the notices go to whoever keeps the
  books. It and the charges row name the economic manager, in a fixed sentence:
  no setting on the instance names that party.
- The English fees text spelled the statute "bokforingslagen"; it is
  "bokföringslagen".

## Consequences

The issue reports, the document archive, the chat, the chat reports, comments on
news and requests about own data leave the export and stay on the access report.
The file says what it carries and where the rest is, in the person's language,
and so does the profile. The export's audit entry names the sections the file
carried, the way the access report's names its own.

A module that adds a section to the access report cannot compile without naming
the row that covers it, and a row the seed has that no section reaches fails a
test until it is mapped or its reason is written down.

The guard is only as complete as the access report. The report does not carry
the `news_delivery`, `meeting_notice_delivery`, `invitation` or `auth_session`
rows kept against a person; the map names two of them as rows no section reaches
and none of the four is closed here.

The requests, breaches and holds have no retention clock. The new rows say so,
which puts that question on the record for a board to read.

The mailbox provider is a recipient the board classifies. The economic manager
is a processor the register cannot list, because nothing in the configuration
names it; the board records it as a recipient of its own.

The new rows appear on every instance at the next start, and the corrected
texts reach every seeded row the board has not edited.
