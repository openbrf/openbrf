# The broker package and personal data: research note

May a housing cooperative release facts about one apartment to a broker
(fastighetsmäklare) through the paid broker package, in which the broker orders
and pays for a broker extract (mäklarbild) through a service Apteo runs? And on
what terms? This note collects what the statutes, the GDPR and the supervisory
guidance say. It then turns that into what the package, and the free "Request
updates" form beside it, would have to do.

> **This is research, not legal advice.** The maintainers wrote it to scope
> engineering work, not to replace a lawyer's opinion. Each conclusion is
> marked **Found** (read in the source cited), **Reasoned** (our reading of a
> source, which a lawyer may read differently) or **Open** (a question for the
> lawyer). Nothing in the paid package ships until the points in
> [What a lawyer must confirm](#what-a-lawyer-must-confirm) have a written
> answer.

The sources were read on 2026-10-19 in the consolidated texts current on that
day. They are listed under [Sources](#sources), and the bracketed numbers in the
text point there.

## The answer

**Yes, on conditions.** Releasing the facts is lawful when every condition
below holds. If one of them fails, the answer for that order is no.

1. **The seller has asked for it.** Every tenant-owner (bostadsrättshavare) the
   apartment register names for the apartment has authorised the release to
   this broker for this sale, and the association has a record of it. No
   statute obliges an association to inform a broker [1][2]. The apartment
   register is not public: only the tenant-owner has a right to an extract of
   it [1]. And IMY says that handing a register's data to anyone outside the
   association needs a basis of its own in the GDPR [7]. Without the seller's
   request there is no such basis. **Reasoned.**
2. **The legal basis is chosen and written down before launch.** The basis is
   either the seller's consent (GDPR art. 6(1)(a)) or the legitimate interest of
   the association and the seller in an orderly transfer (art. 6(1)(f)), with
   the seller's authorisation as the safeguard. A legal obligation (art.
   6(1)(c)) is not available, because no statute requires the release. We
   recommend art. 6(1)(f), for the reasons given under
   [Legal basis](#legal-basis). **Open**: the lawyer picks the basis.
3. **The extract carries only the fields in
   [the field list](#the-extract-field-list)**: what fastighetsmäklarlagen has
   the broker check and describe [2], and nothing more. It carries no personal
   identity numbers, no contact details, no residents who are not tenant-owners,
   and no fee arrears. Open BRF records no fee arrears at all
   ([ADR 0011](adr/0011-fees-and-notices.md)). **Reasoned.**
4. **A board member releases it, and nothing leaves on its own.** The release
   is the association's decision as controller. It is audited, and the
   tenant-owners named in it see it in their data subject access report. The
   property manager role cannot release, because it never reaches the address
   book or the registers (`PROPERTY_MANAGER_CAPABILITIES` in
   `apps/api/src/authorization/capabilities.ts`); delegating the release to it
   would be a board decision that widens that role. **Reasoned.**
5. **A processor agreement is in place between the association and Apteo** for
   the delivery, before the plugin is enabled. Apteo uses nothing it carries
   for any purpose of its own. **Reasoned**, and **Open** for the role split
   itself.
6. **The association's privacy notice and record of processing activities name
   the disclosure:** brokers as a category of recipient, Apteo as a processor.
   **Found** (GDPR art. 13(1)(e), art. 30(1)(d)) [5].
7. **An apartment whose tenant-owner has protected personal data (skyddade
   personuppgifter) is never served by the package.** The plugin cannot see
   such a person at all ([plugin contract](plugin-contract.md#permissions)). The
   order is answered with the same refusal as any other, and the board deals
   with that sale outside the platform. **Reasoned.**

The statutory route stays open and stays free. A tenant-owner may ask the
board for an extract of the apartment register about their own apartment
(bostadsrättslagen 9 kap. 11 §) [1] and hand it to the broker. Bostadsrättslagen
7 kap. 14 § forbids the association from charging special fees for what the act
makes it do [1], so that extract can never be part of the paid package. The
package makes a sale faster and puts it on the record. It does not create a
right that does not exist without it.

## What the statutes say

**Bostadsrättslagen (1991:614)** [1], **Found** unless marked:

- The member register (medlemsförteckning) holds each member's name and postal
  address, when they joined and which bostadsrätt they hold. It is kept
  available at the association "för var och en som vill ta del av den" (9 kap.
  9 §). Who holds which bostadsrätt is therefore not confidential as such.
- The apartment register (lägenhetsförteckning) holds the apartment's
  designation, location, number of rooms and other spaces, the date the
  economic plan was registered, the tenant-owner's name and the initial share capital (insats). A
  lien the association is told of, and every change, is noted at once (9 kap.
  10 §).
- Only the tenant-owner has a right to an extract of it, and only about their
  own apartment (9 kap. 11 §).
- Transfer: the sale must be in writing, signed by both, and state the
  apartment and the price (6 kap. 4 §). The buyer may use the bostadsrätt only
  once admitted as a member (6 kap. 1 §). A buyer does not answer for the
  seller's debts to the association, except where the bostadsrätt passed by
  bodelning, inheritance, will or the like (6 kap. 8 §). Arrears therefore
  matter to a buyer far less often than brokers' questionnaires suggest.
- Fees: the association may charge a transfer fee and a pledge fee where the
  bylaws say so, and "får i övrigt inte ta ut särskilda avgifter för åtgärder
  som föreningen ska vidta med anledning av denna lag" (7 kap. 14 §).
- No section gives a broker or a prospective buyer a right to information from
  the association. The only things the act makes available to anyone are the
  economic plan (3 kap. 5 §) and the member register (9 kap. 9 §).
- Pending: Lag (2026:486) amends 9 kap. 10 § to drop the lien note (pantnotering), 7 kap.
  14 § to drop the pledge fee, and 7 kap. 31 § to have the association tell
  Lantmäteriet, rather than the lienholder, about overdue fees. Each enters into
  force on a day the government sets.

**Fastighetsmäklarlagen (2021:516)** [2], **Found**:

- The broker must check who has the right to dispose of the bostadsrätt and
  whether it carries a lien (3 kap. 13 §).
- The broker's description (objektsbeskrivning) of a bostadsrätt gives the
  association's name and the liens, the participation share (andelstal), the
  apartment's number and size, the land and spaces that go with it, the annual
  fee and decided changes to it, the indirect net debt and the running costs.
  The broker also hands over the latest annual report and the bylaws (3 kap.
  15 §).
- The act does not say where the broker gets the facts. Fastighetsmäklar-
  inspektionen says the check is normally made by contacting the association's
  board, and that the result goes into the description except for who owns the
  apartment [3].

**The cooperative housing register** [4], **Found**:

- Lag (2026:484) om bostadsrättsregister has Lantmäteriet keep a register of
  every bostadsrätt, its holder and its liens. Lantmäteriet is the controller
  of it. Registration of a lien, which the lienholder applies for, replaces
  notice to the association as what makes the lien good against third
  parties. The register is public, and transfers and credit decisions are among
  its stated purposes. The act enters into force on a day the government sets,
  and no date had been set on 2026-10-19.
- Lag (2026:485) enters into force on 1 January 2027 and has every association
  supply its data to Lantmäteriet by 31 December 2027.
- Once the register is in use, the association no longer notes liens, and a
  broker reads them from Lantmäteriet.

## What moves where

The flow planned for the broker package (the paid modules line in
[ROADMAP.md](../ROADMAP.md)), with the personal data at each step:

| Step | What happens                                                                                                       | Personal data                                                                                  | Held by                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1    | The broker orders an extract for one apartment at the Apteo service and pays.                                      | The broker's name, firm, email and phone. The apartment reference. The seller's authorisation. | Apteo (its own customer data)            |
| 2    | The Apteo service passes the order to the association's instance.                                                  | The same, without payment details.                                                             | Apteo as processor, then the instance    |
| 3    | The plugin drafts the extract from recorded facts.                                                                 | The field list below.                                                                          | The instance                             |
| 4    | A board member checks the seller's authorisation, reviews the draft, and releases or refuses it.                   | As step 3, plus who decided.                                                                   | The instance; audit log                  |
| 5    | The instance sends the released extract to the Apteo service, which delivers it to the broker and then deletes it. | The extract.                                                                                   | Apteo as processor, then the broker      |
| 6    | The broker uses the extract for the sale.                                                                          | The extract.                                                                                   | The broker, as an independent controller |

The free "Request updates" form on the public broker information page is a
separate flow. It is covered under [Request updates](#request-updates).

## Who is who

| Party                                                 | Role for this flow                                                                                                                                                                                                                                                                                                                                             | Basis                                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The association                                       | **Controller** of the apartment register, and of the decision to disclose from it. It decides whether, what and to whom. The EDPB names "an association processing personal data about its members" as a controller by its nature [6].                                                                                                                         | GDPR art. 4(7) [5]; EDPB para. 27 [6]. **Found.**                                  |
| Apteo, for the order, the payment and its bookkeeping | **Controller** of its own customer relationship with the broker. Apteo decides to sell the service, sets its price and terms, invoices, and keeps its own books. The EDPB's telecom example has a provider be controller of its own billing data while processing message content for others [6].                                                              | art. 4(7); EDPB para. 27 [6]; its bookkeeping duty [9]. **Reasoned.**              |
| Apteo, for carrying the extract                       | **Processor** for the association. It moves a document the association decided to release, to the recipient the association approved, and keeps nothing afterwards. The association decides the purpose and the essential means (which data, which recipient, how long). Apteo decides only non-essential means such as the file format and the transport [6]. | art. 4(8), art. 28 [5]; EDPB paras. 39-40 [6]. **Reasoned**, **Open** (see below). |
| The broker                                            | **Independent controller** once the extract is received. The broker processes it for their own duties under fastighetsmäklarlagen [2]. The EDPB treats a recipient processing for its own purposes as a controller, and the disclosure as one between controllers [6].                                                                                         | EDPB para. 92 [6]. **Reasoned.**                                                   |
| The seller (each tenant-owner)                        | **Data subject.** It is their apartment, their initial share capital and their liens.                                                                                                                                                                                                                                                                          |                                                                                    |
| Lienholders (usually banks)                           | Named in a lien note. A bank is a legal person and its name is not personal data. A lienholder who is a natural person is.                                                                                                                                                                                                                                     | GDPR art. 4(1). **Reasoned.**                                                      |

Apteo holds two roles towards two parties, and the line between them must be
drawn in the contracts. The EDPB accepts that one entity can be a controller for
some processing and a processor for other processing, judged one processing at
a time (paras. 26 and 82) [6]. The line fails if Apteo uses anything it carries
for a purpose of its own, such as a price database, statistics across
associations, or marketing to the broker based on the apartment. A processor
that does that becomes a controller for that processing (para. 81) [6], with no
basis of its own for the seller's data. The processor agreement has to forbid
it in so many words.

There is also a risk of joint controllership (art. 26). The CJEU has found joint
controllership where a party takes part in deciding the purposes and means even
without access to the data (C-210/16 _Wirtschaftsakademie_, C-40/17 _Fashion
ID_) [8]. Apteo designs the product, decides which fields an extract can carry,
and is paid per order. A lawyer should confirm that this still makes Apteo a
processor and not a joint controller. If it is a joint controller, the
association and Apteo need an art. 26 arrangement instead of, or alongside, the
art. 28 agreement.

## Legal basis

### No statute makes the association inform a broker

**Reasoned, from [1] and [2].** Bostadsrättslagen gives the association duties
towards its members, towards the lienholder, and soon towards Lantmäteriet. It
gives none towards a broker or a prospective buyer. The duties under
fastighetsmäklarlagen are the broker's, and that act does not say where the
facts come from. So art. 6(1)(c), which needs a legal obligation on the
controller itself (art. 6(3)) [5], does not cover the release.

The one statutory right in play belongs to the seller: the extract of 9 kap.
11 §. The package can be read as serving that right faster and directly to the
recipient the seller names. That reading supports the release, but it does not
make art. 6(1)(c) the basis: the right is to an extract for the holder, not to
delivery to a third party.

### Consent or legitimate interest

**Consent, art. 6(1)(a).** Consent fits the shape of the flow: the seller asks,
and the association acts on it. Its weaknesses are practical. Art. 7(3) lets the
seller withdraw at any time, so a withdrawal halfway through a sale must stop
any later release. An extract already delivered stays with the broker, who is
its own controller by then. Art. 7(1) puts the burden of proof on the
association. And a consent given only because the broker said it was needed is
arguably not freely given (art. 4(11), art. 7(4)). None of this rules consent
out.

**Legitimate interest, art. 6(1)(f).** The interests are real. The seller wants
to sell. The association wants a transfer that reaches it with correct facts and
a buyer it can examine for membership. The broker has duties under the statute.
Disclosing a bounded field list to the seller's own broker is necessary for
that, and the balancing test is easy to pass when the seller has asked for it.
The authorisation stops being the legal basis and becomes the safeguard that
tips the balance. A withdrawal is then an objection under art. 21, with the same
practical effect: no later release. IMY's guidance on handing a member register
to someone outside the association points the same way. The membership
contract does not cover it, and legitimate interest may, once the association
has checked why the recipient wants the data [7].

**Recommendation.** Build the package so that it does not matter which of the
two the lawyer picks. Every release requires a recorded authorisation from every
tenant-owner, and the record of processing activities carries the basis the
lawyer chose. Changing the label then needs no code change. We lean towards art.
6(1)(f), because the facts come from a register kept under a legal obligation,
and consent as the basis for a disclosure from such a register sits oddly.
**Open.**

### Market practice

**Secondary sources** [10]. Large property managers sell the mäklarbild to
brokers for about 450 to 1 600 kronor. Some require a fullmakt from the member
(an HSB association's page says so in so many words). Others let the broker
fetch the extract with no board involvement at all (Nabo: "utan hantering av
styrelsen"). Mäklarsamfundet argues that charging for it is not allowed under
bostadsrättslagen 7 kap. 14 §. That is an industry body's position, not a
ruling, but it is the question a lawyer has to settle (point 2 below). The
package here is deliberately stricter than the no-board model: a board member
releases every extract.

### The fields that need care

- **Lien notes (pantnoteringar)** are the seller's financial data. The broker
  must check them (fastighetsmäklarlagen 3 kap. 13 §) [2], and today they sit in
  the apartment register (bostadsrättslagen 9 kap. 10 §) [1]. Once the
  cooperative housing register is in use, liens are registered there, publicly,
  and the association stops noting them [4]. From that day the extract must stop
  carrying liens rather than give a second answer that may disagree with the
  register. **Open**: until then, whether releasing the lien amounts needs more
  than the seller's authorisation. IMY's comments on the register inquiry single
  out liens and unpaid fees as sensitive [7].
- **Fee arrears (avgiftsskuld)** are not in the extract and cannot be: Open BRF
  records no payment and no balance ([ADR 0011](adr/0011-fees-and-notices.md)).
  A buyer does not take them over in an ordinary sale anyway (6 kap. 8 §) [1].
  A broker who asks is pointed to whoever keeps the books.
- **Subletting consent (andrahandsupplåtelse) and alteration permissions** say
  something about how the seller uses the apartment. They are useful to a
  buyer, but fastighetsmäklarlagen does not ask for them. **Open**: whether
  either may be included on the same authorisation.
- **Disputes, forfeiture matters and notices served** are never in the extract.
  The platform does not record them as facts about an apartment, and a lawyer
  would be needed for each one.

## The extract: field list

What the package may put in an extract, matched against what fastighetsmäklarlagen
3 kap. 13 and 15 §§ ask the broker for [2] and against what an instance records
today. "Source" names the model in `apps/api/prisma/schema.prisma`. Every field
needs a public plugin API that does not exist yet (see
[Gaps](#gaps-for-the-gap-audit)).

| Field                                                                              | Asked for by           | Source                                                    | Personal data              | In the extract                                       |
| ---------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------- | -------------------------- | ---------------------------------------------------- |
| Association name, organisation number                                              | 3 kap. 15 §            | `Association`                                             | No                         | Yes                                                  |
| Association facts (fees policy, transfer and pledge fees, land, building, parking) | 3 kap. 15 § 4, in part | Association facts, as on the free page                    | No                         | Yes, as the free page shows them                     |
| The date the board last confirmed those facts                                      | -                      | Association facts                                         | No                         | Yes                                                  |
| Apartment number (Lantmäteriet numbering), address, floor                          | 3 kap. 15 § 3          | `Apartment`, `Address`                                    | Yes, with the holder       | Yes                                                  |
| Participation share (andelstal)                                                    | 3 kap. 15 § 2          | `Apartment.participationShare`                            | Yes, with the holder       | Yes                                                  |
| Monthly fee in force, and rates decided for a later date                           | 3 kap. 15 § 5          | `Fee` (a forward-dated `appliesFrom` is a decided change) | Yes, with the holder       | Yes                                                  |
| Initial share capital                                                              | -                      | `Apartment.initialShareCapital`                           | Yes; confidential register | Yes, **Open**: not asked for by the broker's duties  |
| Name of each tenant-owner                                                          | 3 kap. 13 §            | Apartment register (member residency)                     | Yes                        | Yes, for the broker's check; not for the description |
| Lien notes: creditor, date noted, amount                                           | 3 kap. 13 §, 15 § 1    | `LienNote` (open ones only)                               | Yes; financial             | Yes, until the state register holds liens            |
| Apartment size, rooms and other spaces                                             | 3 kap. 15 § 3-4        | Not recorded (gap 6)                                      | Yes, with the holder       | Not until recorded                                   |
| Indirect net debt, running costs                                                   | 3 kap. 15 § 6-7        | Not recorded; from the annual report                      | No                         | No; the broker has the annual report                 |
| Alteration permissions: date and subject                                           | -                      | `ApartmentDocument` (`ALTERATION_PERMISSION`)             | Yes                        | Optional, **Open**                                   |
| A subletting consent in force                                                      | -                      | `SubletApplication`                                       | Yes                        | Optional, **Open**                                   |
| Fee arrears                                                                        | -                      | Not recorded (ADR 0011)                                   | -                          | Never                                                |
| Personal identity numbers                                                          | -                      | Never reachable by a plugin                               | -                          | Never                                                |
| Contact details of anyone                                                          | -                      | Address book                                              | -                          | Never                                                |
| Residents who are not tenant-owners                                                | -                      | Address book                                              | -                          | Never                                                |
| Anyone with protected personal data                                                | -                      | Never reachable by a plugin                               | -                          | Never; the order is refused                          |

The initial share capital is the one field nothing in the broker's duties asks for, and it
comes from the confidential register. Leave it out unless the lawyer and the
board want it.

## Request updates

The free core form on the public broker information page lets a broker ask the
board to refresh facts that are older than the association's threshold (three
months by default). It is core, not plugin, so it has no manifest. It is a
processing of the association's own, in the record of processing activities, as
the contact form is.

### What it holds

| Field                | Required             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email address        | Yes                  | So the board can tell the broker the facts are confirmed. Encrypted at rest, as the contact form's is.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Name                 | Optional             | So the board knows who is asking.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Firm                 | Optional             | The same. A firm is a legal person, but together with a name it identifies the broker.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Phone                | Not asked            | Email is enough to answer. Not asking is the minimisation art. 5(1)(c) wants [5].                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Apartment reference  | Recommend not asking | The free page carries no per-apartment facts, so refreshing it does not need one. And "a broker asked about apartment 1102" tells the board, and anyone who later reads the inbox, that the tenant-owner of 1102 is selling: personal data about the seller, from a public form, without them. If the board keeps the field, it is optional, it is never checked against the register (an answer that differs for an existing number turns the form into a way to list apartments), and it has the same retention as the rest of the request. |
| A short bounded note | Optional, short      | Free text from a public form can name anybody, so it is the `freeText` category. Bounded, and refused when it holds a personal identity number, as the broker page's own fields are.                                                                                                                                                                                                                                                                                                                                                          |
| Received at          | Automatic            | For the retention clock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The client address is used for the rate limit and is not stored with the
request. The public rate limit keeps its buckets in memory only
(`apps/api/src/http/public-rate-limit.guard.ts`).

### Basis, who sees it, and for how long

- **Basis**: legitimate interest (art. 6(1)(f)). The association keeps the facts
  it publishes accurate and answers whoever asks. That is the basis the contact
  form already records (`contactSubmissions` in
  `apps/api/src/data-protection/processing-activity-seed.ts`). **Reasoned.**
- **Who sees it**: whoever may edit the association facts, which means holding
  `site:manage`, a board capability. The property manager role does not hold it
  (`apps/api/src/authorization/capabilities.ts`). It is not shown to members,
  not offered as an action on the `mcp` or `ai` surfaces, and not readable by
  plugins.
- **Information at collection** (art. 13(1)) [5]: the form says, in a line
  beside the button, who the controller is (the association), why the address
  is asked for, the legitimate interest, how long it is kept, and links to the
  privacy notice.
- **Retention**: we propose deleting a request **30 days after the board
  confirms or edits the facts**, which answers every open request, and **90 days
  after it arrived** in any case. The broker's purpose ends when the facts are
  confirmed, and 30 days covers a follow-up question. 90 days is one default
  staleness threshold: a request the board has not answered in that time is
  better asked again, by a broker whose sale is still open. The deletion is a
  scheduled purge, not a board act. The contact form today has no bounded
  retention other than the board deleting a message (`ContactService.remove`),
  and this form should not copy that. **Reasoned**; the numbers are a proposal
  for the board.
- **Data subject access report**: the request names a person, so it is answered
  for by email address
  ([ADR 0019](adr/0019-every-column-that-names-a-person-is-answered-for.md)), in
  an extract of its own rather than on a person's report: see "As built".
- **Record of processing activities**: a new seeded activity. Source service
  data; basis legitimate interest; data subjects `external`, and `member` if the
  apartment reference stays; categories `name`, `email` and `freeText`, and
  `apartment` if the reference stays.

### Audit

The request is audited when it arrives, and again when the board answers it by
confirming or editing the facts. Neither entry carries the email address, name
or note. The audit log is append-only and never purged (the `auditLog` activity
in the record of processing activities says so), so a broker's address written
into it would outlive the 90-day retention for good. The entry carries the
request's id and the action, and the request row carries the rest until it is
purged.

### As built

The form follows this section, with these choices where it left one open:

- **The apartment reference is kept, and optional.** The per-apartment limits
  need it when a broker names one. It is the broker's own text, normalised to
  capitals, and is never looked up in the apartment register: the form answers
  the same for any number. So the record of processing activities lists
  `apartment` among the categories and `member` among the data subjects.
- **The note** is at most 280 characters and is refused when it holds a
  personal identity number.
- **Limits**: the route's in-memory limit per client address, one open request
  and three in 30 days per apartment reference, five a day per broker address,
  and twenty a day in all. The last three are counted in the request table, so
  a restart does not reset them. No client address is stored.
- **Retention** is the proposal above: 30 days after the answer, 90 days after
  arrival in any case, by a nightly purge. A request the board dismisses is
  deleted at once, and the dismissal is audited too.
- **The notice at collection** names the association, the purpose, the
  legitimate interest and both retention periods, and links to the privacy
  notice when the association has published one.
- **When the form is offered**: once the facts are older than the board's
  threshold, counted to the instant on the Stockholm wall clock from the moment
  they were confirmed, with a day the target month lacks held to its last day.
  Recorded facts the board has never confirmed count as older, and the form
  says they were never confirmed.
- **The board is told** by email, once per stored request, at the address of
  everybody who holds `site:manage`. The notice names the apartment if the
  broker gave one, and links to the queue. It carries no name, address, firm
  or note, so no copy of the broker's details outlives the request in a
  mailbox.
- **The access report** is an extract by address rather than a section of the
  person report. A board member enters the broker's address, and every request
  held under it is mailed to that address and to no other; the board member is
  told how many and never sees the extract. Delivering it to the address is the
  verification an address-keyed request allows, and nothing is joined to a
  person the register holds, because an address can be shared or change hands.
  The audit log records the act and the count, not the address.

The code is in `apps/api/src/broker-update-requests/`, and the staleness rule
the page and the endpoint share is `apps/api/src/site/facts-currency.ts`.

## The paid package's manifest

What the broker package plugin declares, against the vocabulary in
`packages/plugin-sdk/src/permissions.ts` and `packages/plugin-sdk/src/actions.ts`.

**Package `personalData`**: `name`, `apartment`, `residency`, `email`, `phone`.
`name`, `apartment` and `residency` cover the tenant-owners in the extract.
`email` and `phone` cover the broker's contact details in the order. The package
also handles lien amounts, the initial share capital and the fee, which are the `financial`
category, and a bounded order note, which is `freeText`. Neither can be declared
at package level today, because `PLUGIN_PERSONAL_DATA_CATEGORIES` stops at the
first five. That is a gap (below). Under-declaring is not acceptable here: the
declaration is what the board consents to and what goes into the record of
processing activities.

**Actions**, all on the `ui` surface only. A release decision belongs in front
of a board member, and nothing that drafts or releases an extract belongs on
`mcp` or `ai`:

| Action (sketch)   | Effect  | `personalData`                                |
| ----------------- | ------- | --------------------------------------------- |
| `list_orders`     | `read`  | `name`, `email`, `phone`, `apartment`         |
| `draft_extract`   | `read`  | `name`, `apartment`, `residency`, `financial` |
| `release_extract` | `write` | `name`, `apartment`, `residency`, `financial` |
| `refuse_order`    | `write` | `apartment`                                   |

The final names and boundaries are the gap audit's to set. The rule that holds
is that each action declares every category it can touch.

**Where it sends personal data.** At install the board answers yes: the plugin
sends personal data outside the instance, to Apteo AB. The board classifies
Apteo as a processor, which needs a processor agreement with the terms of art.
28(3) [5], recorded on the data protection screen
([plugin contract](plugin-contract.md#where-the-plugin-sends-personal-data)).
Brokers are a second recipient, and an independent controller. The install step
names one recipient, so recording brokers as a category of recipient is a gap
too.

**Audit entries**: one each for an order received, an extract released and an
order refused. Each one carries:

- `actorPersonId`: the board member who decided, or none for an order arriving;
- `targetPersonId`: each tenant-owner named in the extract, one entry each, so
  the release shows in their own data subject access report. Art. 15(1)(c) gives
  them the right to know the recipients [5];
- `targetKind` `apartment` and its id;
- `context`: the Apteo order id, the broker's firm, the names of the fields
  released (not their values), and a reference to the seller's authorisation.

The broker's personal name and contact details stay out of the audit log, for
the same reason as on the free form. The firm and the order id answer art.
15(1)(c), which asks for recipients, and Apteo can resolve an order id to a
broker for as long as it keeps its own order records. **Open**: whether the
lawyer wants the individual broker named in the log.

### Retention in the paid package

| What                                                  | Where    | Proposed retention                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Order row (broker contact, apartment, status)         | Instance | 30 days after the order closes. It closes on release, refusal or cancellation by the broker, or, if no board member has decided, 60 days after it arrived: it then counts as refused and the broker is told                                                                                                                                                                                                  |
| The seller's authorisation record                     | Instance | After a release: 3 years after the release, as evidence the release was lawful (art. 5(2)). **Open**: the general limitation period is ten years (preskriptionslagen (1981:130) 2 §), so the lawyer sets the period. With an order that closes without a release (refused, cancelled or expired): deleted with the order row, 30 days after it closes. Nothing was released, so there is nothing to evidence |
| The released extract                                  | Instance | No copy kept. The audit entry records which fields went                                                                                                                                                                                                                                                                                                                                                      |
| The released extract                                  | Apteo    | Deleted when the broker has downloaded it, and 14 days after release at the latest                                                                                                                                                                                                                                                                                                                           |
| Order and payment records                             | Apteo    | Until the end of the seventh year after the calendar year in which Apteo's financial year ended (bokföringslagen 7 kap. 2 §) [9]. The invoice carries the order id and the association's name, never the apartment or the seller                                                                                                                                                                             |
| An order that was never paid, or whose payment failed | Apteo    | The order data is deleted 30 days after the last attempt. Nothing was passed to an instance. **Open**: how long the payment provider's own record runs                                                                                                                                                                                                                                                       |
| Audit entries                                         | Instance | Never purged, as the whole audit log. They hold no values                                                                                                                                                                                                                                                                                                                                                    |

The authorisation record does not store a scanned signed document. Such a
document would usually carry a personal identity number, which the instance
keeps out of places like this. It records who authorised, when, and through
which channel (for example signed with BankID at the Apteo service, with the
signing reference).

## Processor agreement with Apteo

What the agreement between each association and Apteo must say, from art.
28(3)(a)-(h) [5]:

- Apteo processes the extract only on the association's documented
  instructions: carry this released document to this broker for this order. It
  tells the association if an instruction would break the GDPR.
- Its staff are bound to confidentiality.
- The security measures of art. 32: encryption in transit, short-lived download
  links, no extract in logs.
- Sub-processors only with the association's prior written authorisation (art.
  28(2)), listed by name: hosting, mail delivery and file storage. The payment
  provider is not one of them. It handles the broker's payment, which is Apteo's
  own processing.
- Help with data subject rights, and with art. 32-36.
- Deletion when the delivery is done (the 14 days above), and at the end of the
  agreement.
- Information and audits to show compliance.
- Explicitly: no use of anything carried for Apteo's own purposes, and no
  aggregation across associations.
- The subject matter, duration, nature and purpose, the types of data and the
  categories of data subjects: the field list and the tenant-owners above.

Apteo also needs **terms of service with each broker** that limit their use of
an extract to the sale it was ordered for. That does not make the broker a
processor, and it is not an art. 28 term. It is what makes the association's
balancing test hold.

A housing cooperative cannot negotiate a processor agreement for a feature
priced like this one, so Apteo publishes a standard one. The board accepts it
on the plugin's install step, and the data protection screen records its date
and reference.

## Gaps for the gap audit

Found while writing this note, for the broker package's gap audit to confirm
and turn into free core tasks:

1. **No plugin permission reaches the apartment register.** `addressBook:read`
   covers apartments, names and residency. The participation share, the initial
   share capital, lien notes and fees are out of reach, so every field the extract needs
   beyond names is a missing public API.
2. **`PLUGIN_PERSONAL_DATA_CATEGORIES` cannot declare `financial` or
   `freeText`.** The package handles both. The first five categories are kept
   equal to the shared list by a test; widening the plugin list means changing
   that test from equality to subset.
3. **The install step names one recipient.** The broker package has two: Apteo,
   a processor, and brokers, a category of independent controllers.
4. **There is no record of a seller's authorisation.** Something has to record
   who authorised a release, when and how, and the board has to be able to
   check it before releasing. Whether that is core or plugin is the gap audit's
   call. The term needs a GLOSSARY entry when it is built: `fullmakt` is already
   taken for a general meeting proxy.
5. **Request updates needs a bounded retention purge.** The contact form has
   none to copy. Closed: the update request purge
   (`apps/api/src/broker-update-requests/broker-update-request-purge.service.ts`).
6. **The apartment register does not record what bostadsrättslagen 9 kap. 10 §
   lists.** `Apartment` has no number of rooms, no other spaces (övriga
   utrymmen) and no size, and the association records no date for the economic
   plan's registration. The first two are statutory content of the register
   itself, not only broker data. That is a core register gap, independent of the
   package.

## What a lawyer must confirm

The board takes these to a lawyer before the paid package ships. The free
Request updates form needs only points 1 and 9.

1. **Legal basis**: art. 6(1)(a) or (f) for the release, and art. 6(1)(f) for
   Request updates.
2. **Bostadsrättslagen 7 kap. 14 §**: that Apteo may charge a broker for an
   extract the association releases, given the ban on special fees for what the
   act makes the association do. The extract is not such a measure, and the
   association charges nothing, but Mäklarsamfundet argues otherwise [10]. Does
   the answer change if the association receives any part of the price?
3. **That no statute obliges** the association to give a broker these facts, or
   forbids it from doing so on the seller's authorisation.
4. **Whose authorisation is enough**: every tenant-owner, or one of several. The
   cases with no tenant-owner to ask: an estate (dödsbo), a forced sale under
   bostadsrättslagen 8 kap., and a sale by the association itself.
5. **Apteo's role**: processor for the delivery and controller for the order,
   and not a joint controller under art. 26. Review the standard processor
   agreement.
6. **The field list**, in particular the lien amounts until the state register
   holds liens, the initial share capital, the alteration permissions and the subletting
   consent.
7. **Retention**: how long the seller's authorisation is kept as evidence (three
   years proposed, against a ten-year general limitation period), and whether
   the audit log may name the broker's firm or the broker.
   For orders that never reach a release (pending until they expire after 60
   days, refused, cancelled, or abandoned before payment), the proposal is
   30 days after the order closes, with the authorisation record deleted
   alongside. The lawyer confirms the 60-day expiry, that nothing need be kept
   as evidence of a refusal, what the broker is owed back when the order is
   refused or expires, and how long the payment provider's record runs.
8. **The broker terms** Apteo sets: whether limiting use to the sale is enough
   for the balancing test.
9. **The privacy notice wording**: the disclosure to brokers, Apteo as a
   processor, and the Request updates notice at collection.

## Sources

1. Bostadsrättslag (1991:614), consolidated through SFS 2026:847: 3 kap. 5 §,
   6 kap. 1, 4 and 8 §§, 7 kap. 14 and 31 §§, 9 kap. 9-11 §§; and Lag
   (2026:486) amending it.
   <https://rkrattsbaser.gov.se/sfst?bet=1991:614>
2. Fastighetsmäklarlag (2021:516), consolidated through SFS 2022:1030: 3 kap.
   13 and 15 §§. <https://rkrattsbaser.gov.se/sfst?bet=2021:516>
3. Fastighetsmäklarinspektionen, "Mäklarens kontrollskyldighet", updated
   2026-09-30.
   <https://fmi.se/vad-galler-vid-formedling/maklarens-ansvar-och-roll/maklarens-kontrollskyldighet/>
4. Lag (2026:484) om bostadsrättsregister, 2 kap. 1-3 §§ and 3 kap.
   <https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-2026484-om-bostadsrattsregister_sfs-2026-484/>;
   Lag (2026:485), 3 §, <https://lagen.nu/2026:485>; Förordning (2026:898),
   <https://lagen.nu/2026:898>; bet. 2025/26:CU28 on prop. 2025/26:112,
   <https://www.riksdagen.se/sv/dokument-och-lagar/dokument/betankande/ett-register-for-alla-bostadsratter_hd01cu28/html/>.
   See also [GLOSSARY.md](../GLOSSARY.md) and
   [the register supply contract](register-supply-contract.md).
5. Regulation (EU) 2016/679 (GDPR), art. 4, 5, 6, 7, 13, 15, 21, 26, 28, 30, 32. <https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679>
6. EDPB, Guidelines 07/2020 on the concepts of controller and processor in the
   GDPR, version 2.1 (version 2.0 adopted 7 July 2021), paras. 26-27, 39-40,
   81-82 and 92.
   <https://www.edpb.europa.eu/system/files/documents/2023-10/EDPB_guidelines_202007_controllerprocessor_final_en.pdf>
7. IMY: "Förening",
   <https://www.imy.se/verksamhet/dataskydd/dataskydd-pa-olika-omraden/forening/>;
   "Så hanterar ni föreningens medlemsregister", updated 2026-09-18,
   <https://www.imy.se/verksamhet/dataskydd/dataskydd-pa-olika-omraden/forening/sa-hanterar-ni-foreningens-medlemsregister/>;
   IMY's comments on SOU 2022:39 (IMY-2022-4622),
   <https://www.imy.se/globalassets/dokument/remissvar/2022/ett-register-for-alla-bostadsratter_sou-2022_39.pdf>.
8. CJEU, C-210/16 _Wirtschaftsakademie Schleswig-Holstein_, 5 June 2018; C-40/17
   _Fashion ID_, 29 July 2019.
9. Bokföringslag (1999:1078), 7 kap. 2 §.
   <https://rkrattsbaser.gov.se/sfst?bet=1999:1078>; and on the authorisation
   record's retention, preskriptionslag (1981:130), 2 §,
   <https://rkrattsbaser.gov.se/sfst?bet=1981:130>.
10. Market practice, secondary sources: Nabo,
    <https://nabo.se/maklarservice-for-maklare/>; an HSB association's broker
    page, <https://www.hsb.se/stockholm/brf/matkilen1/maklarinformation/>;
    Mäklarsamfundet, "Århundradets affärsmodell" (2025),
    <https://www.maklarsamfundet.se/sites/default/files/Media%20Opinion/pdf/F%C3%B6rvaltares%20m%C3%A4klaravgifter.pdf>.
