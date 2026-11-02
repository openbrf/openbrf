# Parking share: record of processing and consent copy

The parking-share module lets whoever holds a parking space offer it for a
period when they will not use it and lets a neighbour claim it, and lets
somebody who needs a space post a wanted ad that a holder can reply to or
reserve their space for (see "Parking space sharing between neighbours" in
[ROADMAP.md](../ROADMAP.md)). It is built only on the public plugin API, so it
appears in the association's record of processing activities (GDPR art. 30)
the way every plugin does: from the `processing` declaration in its manifest
([ADR 0035](adr/0035-a-plugin-s-processing-and-objecting-to-it.md)). The
records it keeps about people are declared as `personRecords`
([ADR 0047](adr/0047-a-plugin-s-records-about-a-person.md)).

This page is the wording of both. The plugin's author copies the declaration
into the manifest and the text keys into the plugin's locale files, and a change
to what the plugin does changes this page in the same pull request. A
declaration narrower than what the plugin does makes the association's record,
and the consent its board gave, wrong ([plugin contract](plugin-contract.md)).

> **Not legal advice.** The maintainers wrote this to fix what the plugin may
> do before it is built. The processing rests on legitimate interest, and a
> lawyer is to review that choice and the interest stated below before an
> association uses the module for real. The version listed in the catalog on
> 2026-11-02 still declares the contract as its basis and has no wanted ads;
> the next release declares what this page says. The points still marked open
> in [Open points](#open-points) need an answer before real use as well.

## What the module processes

| What                                                                                                                             | About whom                                                                      | Kept in                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| Which space belongs to which household's member                                                                                  | The person the board assigns it                                                 | `host.personRecords`, `assignments`              |
| An offer: space, first and last day, open, withdrawn or pending, claimed or not, whether the holder shows their name             | The person who offers                                                           | `host.personRecords`, `offers`                   |
| A day an offer holds: space, day                                                                                                 | The person who offers; once a neighbour claims the offer, the person who claims | `host.personRecords`, `days`                     |
| A claim: space, first and last day, cancelled or not, whether the claimer shows their name                                       | The person who claims                                                           | `host.personRecords`, `claims`                   |
| A wanted ad: first and last day, a note, whether the poster shows their name and apartment                                       | The person who posts it                                                         | `host.personRecords`, `wanted-ads`               |
| A reply to a wanted ad: which ad, a note, whether the holder shows their name                                                    | The holder who replies                                                          | `host.personRecords`, `replies`                  |
| The spaces themselves: a label, how many assignments the space has had and whether the latest stands, nothing about a person     | Nobody                                                                          | `host.records` (ADR 0033), `spaces` and `labels` |
| An audit entry for each offer, claim, wanted ad, reply, reservation, withdrawal and removal                                      | The actor, and the person                                                       | `host.audit` (ADR 0035, ADR 0047)                |
| A confirmation mail to the holder and to the claimer                                                                             | The person mailed                                                               | Not kept; sent through `host.mail` by a job      |
| A mail to a poster about a reply, a reservation, or a removal of their ad or of a reply; a mail to the holder of a removed reply | The person mailed                                                               | Not kept; sent through `host.mail` by a job      |

`labels` holds one record per space label, keyed by a hash of the label in lower
case, and its value is the id of the space that holds the label. It holds
nothing about a person.

A `spaces` record also counts the assignments the space has had (`assignments`)
and says whether the latest one stands (`held`). Neither says who holds the
space. An assignment is keyed by the space's id and its number, so a new
assignment of a space takes the next number and never a key an earlier holder's
assignment had.

`days` holds one record for each day an offer holds on its
space, keyed by the space's id and the day, so of two offers of the same day
only one can hold it. The record names the space's label, the day and the id of
the offer, and the key of the claim once the offer is claimed. It is about the
person who offers until a neighbour claims the offer. The claim then rewrites
the record about the person who claims, so that the day stays held through an
erasure of the holder's records. A cancelled claim gives it back to the holder
when the plugin can read the offer and name the holder. The claimer's
cancellation clears the claim's key from the record, and a job of the plugin's
then rewrites it about the holder, because a route a resident calls may name
only the caller or the person the record it replaces is about (see below).
Until the job has run, and after it when the claimer is withheld from the
plugin by the time it gives the days back, the record stays about the claimer;
when the offer is
unreadable or the holder cannot be named, for example after the holder's
records are erased, or when the job cannot be queued, the cancellation still
stands, the claim's key is cleared
and the record stays about the claimer until the host erases it or another
offer takes it over. It is erased the day after its day. The plugin never deletes it: an
offer, a withdrawal or a cancellation leaves it where it is, and the next offer
of the day takes it over when the offer it names no longer holds the day. The
host keeps the key of a record it hides from the plugin, so a day stays held
while the person it is about is withheld from the plugin, which is what keeps
the day from being offered twice when the holder and the claimer are both
withheld. Like `audited`, the offer's id and the claim's key in it are stored
keys without a label on the access report.

An offer has one of three statuses. It is written `pending` and becomes open
only after the plugin's checks pass. A pending offer is never shown to a
neighbour and cannot be claimed. One that a failed call leaves behind stays in
`offers` while it is retained, so it can appear with the status `pending` on the
holder's access report. It may survive to its erase date if nothing recovers it,
but the plugin can clear it sooner. For example, when a later offer for an
overlapping period meets a pending offer at least a minute old, it clears that
leftover, and removing the space's assignment clears it too. Clearing deletes an
offer that was posted for the first time. An offer that was opened again (see
below) is not deleted: it goes back to `withdrawn`, because claims on its
earlier rounds name it.

A withdrawn offer can be opened again. When the holder offers the same space for
the same days as one of their withdrawn offers, the plugin rewrites that record
to `pending`, and to `open` once its checks pass, on a new round, instead of
adding an offer. The record keeps its erase date and the audit log keeps an
entry for every posting and withdrawal, so nothing is lost, but the offer's
status can change again after it was withdrawn.

Repeated offers, claims and wanted ads are held back, so they cannot fill the
plugin's store. A new offer is refused when the person already has 50 offers
that are pending or open up to their last day, or 50 withdrawn offers. A new
claim is refused when they already have 30 active claims up to their last day
or 50 cancelled claims. A new wanted ad is refused when they already have 10
wanted ads up to their last day. The check runs before anything is written.
Reopening a withdrawn offer adds no record, so the withdrawn-offer threshold
does not apply to it. Withdrawing and cancelling are never refused, so the
offers and claims that were open or active when the last new one was admitted
can all become withdrawn or cancelled afterwards, and the thresholds are not
maxima for the records a person keeps. Instances of the plugin writing at the
same time can each pass a threshold once more. The thresholds add no category
of data.

Offers and claims also carry an internal `audited` flag. The manifest does not
declare it, so it has no label; the access report still includes it as
an unlabelled stored key, because the report lists every key a record stores
(ADR 0047).

An offer's `claimed` says only that the current round has a claim. It never
says who claimed it, and it still counts after the address book stops listing
the claimer.

The plugin reads names, apartments and email addresses from the address book to
show the board an overview and to send the mails. It stores none of them: a
record names a person by id and refers to the register for the rest (ADR 0047,
"The record refers to the register and does not copy it"). A name a person
chose to show is not read by the plugin at all: the host adds it to the record
on each read (see "A name shown at its owner's choice" below).

**Nobody is named unless they choose to be.** Whoever the module serves sees an
open offer as a space label and dates, and a wanted ad as its dates and its
note. Each person chooses, on each offer, claim, wanted ad and reply they make,
whether the others see who they are, and the choice is off until they tick it:
a holder or a claimer shows their name, and a poster shows their name and
apartment, or their name alone when the address book gives them none. An
unnamed wanted ad reads "Någon söker plats" (somebody is looking for a space).
The board sees every name, whether or not it is shown to the others. The module
handles no money: a payment between neighbours would be a taxable supply
needing an invoice (ADR 0011) and is outside it.

The confirmations go from a job of the plugin's (`host.jobs`), queued once a
claim or its cancellation is recorded, because a route a resident calls may not
read the list of residents ([ADR 0051](adr/0051-resident-routes-in-a-plugin-that-reads-the-register.md))
and the holder's address is only there. The job's data is the act, the claim's
key and the claim record's identity, and names no person. The job reads the
claim, its offer and the address book when it runs, and mails each of the two
the address book then lists with an address, each in a mail of their own. Once
the claim is erased it mails nobody, also when the next claim on the round has
taken its key since: that record has another identity. The board chooses the
mail's language, Swedish or English, in the plugin's settings.

A second job gives a cancelled claim's days back to the holder, queued by the
cancellation, for the same reason: on a route a resident calls the host refuses
a record that names anybody but the caller or the person the record it replaces
is about (ADR 0051), and the cancellation is the claimer's. Until the job has
run, the offer stays on the cancelled claim's round, so it counts as claimed
while the claimer is withheld and nobody is offered a day they cannot claim.
When the job cannot be queued, because the board has not consented to
`jobs:schedule` or the queue refuses it, the cancellation ends the round itself
and the days stay about the claimer, as above. The job's data is the claim's
key and the claim record's identity, and names no person. The job reads the
claim and its offer when it runs, rewrites the claim's days about the holder,
and then opens the offer for its next round, or withdraws it when the holder no
longer holds the space. Once the claim is erased, it gives back only the days
left about a claimer and naming the offer alone. It does the same, and leaves
the offer on the claim's round, when the claim can no longer be read by the
time it gives the days back: a claimer withheld since the job read the claim
keeps the days the job cannot see, and the offer counts as claimed for as long
as the cancelled claim stays unreadable, so nobody is offered a day they cannot
claim. Once the claimer is listed again the cancelled claim can be read, the
offer no longer counts as claimed and is offered for its next round, and the
days are given back when the claimer cancels again, or pass to whoever claims
the next round. A claim that fails after moving days leaves the same job to
give them back.

### Wanted ads

A wanted ad says that somebody needs a parking space from a first to a last day,
one day allowed, with a note of at most 200 characters. Its last day is at most
365 days after the day it is posted. It is the poster's record. Everybody the
module lets act sees it, with the poster's name and apartment only when the
poster ticked that box.

A holder answers an ad in one of two ways:

- **A reply** is a note of at most 200 characters, shown to the poster and
  mailed to them; the holder who wrote it and the board can read it too, and
  no other resident can (rule 15). It is the holder's record, and a holder has
  one reply to an ad: its key is the ad's id and the holder's own id, so a second reply
  rewrites the first. The holder can change it or withdraw it. Withdrawing
  clears the note and marks the reply withdrawn, and keeps the record, with no
  note, until the ad is erased, so that the reply's mail budget (below) survives
  a withdrawal. Replying again rewrites the same record. It is not a
  conversation: the poster does not answer it in the module.
- **Reserving** picks one of the holder's spaces and all or some of the ad's
  days, and the space is claimed for the poster at once. It writes the same
  records an offer and a claim do: an offer about the holder, the days and a
  claim about the poster. The poster sees the claim among their own, with the
  space label and the days, and can cancel it as any claim, which gives the days
  back as above. The days it does not cover stay open on the ad. The claim
  keeps a claim's retention, a year after its period, and outlives the ad.

The holder's name is shown on a reply or a reservation only when the holder
ticked that box; the poster always sees the space label and the days. Holders
are not told about a new ad, by mail or otherwise, beyond the ad appearing on
the page.

The poster is mailed when a holder replies, when a holder reserves a space for
them, and when the board removes their ad or a reply to it. When the board
removes a reply, the holder who wrote it is mailed about it as well, in a mail
of their own. A reply's mail and a reservation's go from a job of the plugin's
handed no person id, as the confirmations do: it reads the reply or the claim,
and the ad, when it runs, and mails the poster as the subject of the ad. A reply's mail carries the reply's note. A removal's mails go from the
board's own route, which is not a resident route and may read the address book,
once the removal is recorded.

**A reply's mail is bounded.** Replies are limited in what they store, but a
holder who writes again, or withdraws and replies again, must not be able to
mail the poster again each time. The plugin keeps a budget, and a reply's mail
is sent only while the budget lasts:

- **One mail for each holder and ad, while the holder's reply record lasts.**
  The first reply a holder writes to an ad sends the poster a mail. Changing
  the reply sends none, and nor does replying again after a withdrawal: the
  reply record outlives the withdrawal, and an internal `mailed` flag on it,
  which the manifest does not declare (like `audited`, the access report still
  lists it as an unlabelled stored key), holds `queued` or `sent` once the
  budget is spent. The flag goes with the record, so after the holder's records
  are erased a new reply can send one more mail; the ad's count below is what
  bounds that. The poster sees a changed note on the page, not in their inbox.
- **At most 10 reply mails for each ad.** An internal `replyMails` count on the
  wanted ad, which holds a number and no person id, counts the mails taken for
  it. When it reaches 10, a reply is still stored and shown to the poster on the
  page, and no further mail goes. This holds when many holders reply, and when
  a holder's records are erased and the holder replies again, which clears the
  holder's flag but not the ad's count. With the limit of 10 wanted ads a person
  can have at one time (rule 10), a poster is mailed about replies at most 100
  times for one such set of ads. The limit counts ads up to their last day and
  is not a total over time: a new ad has a budget of its own, so a poster who
  posts again after earlier ads have ended can be mailed more.
- **The budget is taken before the mail is queued, not when it is sent.** The
  write that spends it is the one that creates the reply or turns a withdrawn
  one live while `mailed` is not set. It is conditional on the reply's and the
  ad's revisions (`expectedRevision`, as the first claim on a round is), so of
  two writes at the same time only one takes the unit; the other stores its
  reply and queues nothing. The plugin queues the job only when it took the
  unit, and a failed queueing does not give the unit back.
- **A retried job sends at most once.** The job's data is the reply's identity
  and names no person. Before it mails, it reads the reply and the ad, mails
  nobody if the reply is withdrawn, removed or erased, and moves the reply's `mailed` from
  `queued` to `sent` with a conditional write that replaces the reply, so it
  names only the person the record it replaces is about (ADR 0051). Only the run that wins that write
  mails. A retry after it finds `sent` and mails nothing, so a mail lost
  between that write and the send is not repeated: the budget bounds mail,
  and a lost one is not made up.

A reply's mail is therefore not a message from the holder to the poster in
real time. It tells the poster that a holder has replied and carries the note
as it stood when the job ran.

A reservation writes a claim about somebody other than the caller, which a route
a resident calls may not do (ADR 0051). The claim is written by a job of the
plugin's, handed no person id, which names the poster only as the subject of
the ad it reads. "Reserving for a poster" below says how.

An ad and its replies are erased 30 days after the ad's last day. A poster who
withdraws their ad deletes it, and the plugin deletes its replies with it. The
board sees every ad and reply on its own screen, with the poster's and the
holder's name whether or not they are shown to neighbours, and can remove any of
them: removal deletes the record, and a removed ad takes its replies with it.
The poster is told of either removal by mail, and so is the holder of a reply
that is removed. These mails are the board's own act and are not counted in a
reply's budget, each removal sends them once, and a removal is recorded before
they are sent. The audit log keeps an entry for each posting, withdrawal and removal, about the
person who wrote what was removed, and names the board member who removed it as
the actor.

**A note can name anybody.** The module asks for a short note about the days and
the space, and tells the poster before they post it that everybody who can act
sees it, but it cannot stop a note naming a third person or saying something
about the poster's health. That is why `freeText` is declared. The host refuses
a personal identity number in any record. A note never goes in an audit entry,
a log or `host.records`. The board's removal is the remedy for a note that
should not be there.

## Who uses the module

The board decided on 2026-11-02 who uses the module, and
[ADR 0053](adr/0053-people-a-resident-route-serves-who-do-not-live-here.md)
says how the host carries that out. The module's routes are resident routes
(ADR 0051). The host decides whom they serve from its own records, on each
request, and never from the plugin's records, settings or answers.

| Who                                                                                                                                         | What they can do                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A resident the address book lists to the plugin                                                                                             | Offer, claim, post a wanted ad, reply and reserve                                                |
| A board member who does not live in the house, while their term runs (`board`)                                                              | The same                                                                                         |
| The administrator (`administrator`)                                                                                                         | The same                                                                                         |
| The property manager (`propertyManager`)                                                                                                    | The same                                                                                         |
| A person the board gave access to the module on their page in the address book, such as somebody who rents a garage (`pluginAccess`)        | The same                                                                                         |
| A former resident, whatever else they hold                                                                                                  | See the page, which says what the module is for and that it is for people connected to the house |
| A person with protected personal data, under a restriction or with a standing objection to the module's processing, whatever else they hold | See the page, with the same text                                                                 |
| Anybody else signed in                                                                                                                      | See the page, with the same text                                                                 |

- **The plugin is told less than this table.** `caller` answers `listed` for a
  resident, `nonResident` for a person served in one of the four classes, and
  `notListed` for everybody else, without saying why or which class. The page
  shows everybody it does not serve one text, so a former resident, a person
  who objected and a person in no class read the same words, and nothing tells
  them which of these they are.
- **The three refusals come first.** No board seat, system role or plugin
  access lifts protected personal data, a restriction or an objection (ADR
  0053, "The order of the refusals").
- **The page is offered to everybody signed in** (`view.offeredTo: "signedIn"`),
  in the building section. Offering the page decides nothing: the routes refuse
  whoever they do not serve.
- **Each class is consented to.** The administrator consents to the four
  classes with the install, on the board's decision, and can withdraw one later
  without removing the module. The audit log records who consented. A class the
  install has not consented to, or has withdrawn, serves nobody.

### A person who does not live here

Every account belongs to a person in the address book, with a person id, so a
person who does not live here is named by that id, as a resident is. Nothing
about them is kept anywhere else.

- **Getting an account.** The account request is for people who live here. The
  board adds a person who rents a space but does not live here to the address
  book without a residency, gives them a plugin access to the module on their
  page, and sends the invitation from there. It then assigns them a space on its
  own view, as it assigns a resident one.
- **Records and the access report.** Their offers, claims, wanted ads and
  replies are records about them, printed on their access report and erased on
  their erasure request, as a resident's are. Their plugin access is on the
  report too. While it stands they are kept, as a person with a system role is;
  once the board withdraws it, they are erased on the same terms as anybody
  else.
- **Mail.** A job finds their address in `host.addressBook.nonResidents()`, as
  it finds a resident's in `residents()`, and mails them on the same terms.
  Neither is read on a route a resident calls.
- **Objection.** They can object to the module's processing like anybody in the
  address book, and are refused from then on.
- **A former resident cannot be given access.** One whose account outlived
  their residency sees the page and does nothing, and their records stay until
  their erase date, as before.

### What a caller outside the house sees

The property manager, and a person who rents a space without living here, are
outside the house. On the module's routes the host refuses every read of the
register, whoever calls, so none of them can read a list of residents,
apartments or other people the module serves. What they see is what people
chose to show to everybody the module serves, with one narrowing:

- **Offers by the days asked for.** A space label with days says when a space
  is free, and a stranger who knows the courtyard can read that as when a
  household is away. So to a caller that `caller` answers `nonResident`, the
  offers route lists only the offers with a day in a span the caller asks for,
  of at most 31 days, and of each offer only its days in that span. A resident
  sees the list as before. This turns a full picture of the house's absences
  into something a person has to ask for span by span; it does not stop
  somebody who does. Board members who live elsewhere get the same list there,
  and see every offer on the board's own view.
- **Wanted ads** are shown to everybody the module serves, with their days and
  note, and with the poster's name and apartment only when the poster ticked
  it.
- **A reply** is shown only to the poster of its ad, to the holder who wrote it
  and to the board, whoever they are.

### What the page tells a person before they act

Before a person offers, posts, replies or ticks a box, the page says who will
see it. Where that is everybody the module serves, it names every class the
module declares, not only neighbours (ADR 0053, "What catalog review reads").
The module cannot tell which classes the install withdrew, so the text may name
one that is no longer served; it never names fewer. The wording, for the
plugin's locale files:

| Where                                        | Swedish                                                                                                                                                                                                                               | English                                                                                                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before an offer or a wanted ad               | Alla som använder parkeringsdelningen ser det här: grannarna, styrelseledamöter som bor någon annanstans, administratören, förvaltaren och de som styrelsen har gett tillgång. Den som vet vems plats det är kan se när den är ledig. | Everybody who uses parking share sees this: the neighbours, board members who live elsewhere, the administrator, the property manager and the people the board has given access. Somebody who knows whose space it is can tell when it is free. |
| The hint for a wanted ad's note              | Alla som använder parkeringsdelningen läser det här, även förvaltaren. Skriv inget om någon annan.                                                                                                                                    | Everybody who uses parking share reads this, the property manager included. Write nothing about anybody else.                                                                                                                                   |
| The hint for a reply                         | Bara den som efterlyste platsen och styrelsen läser det här.                                                                                                                                                                          | Only the person who posted the wanted ad, and the board, read this.                                                                                                                                                                             |
| The tick on a wanted ad                      | Visa mitt namn och min lägenhet för alla som använder parkeringsdelningen, även förvaltaren                                                                                                                                           | Show my name and apartment to everybody who uses parking share, the property manager included                                                                                                                                                   |
| The tick on an offer                         | Visa mitt namn för alla som använder parkeringsdelningen, även förvaltaren                                                                                                                                                            | Show my name to everybody who uses parking share, the property manager included                                                                                                                                                                 |
| The tick on a claim                          | Visa mitt namn för den som erbjöd platsen                                                                                                                                                                                             | Show my name to the person who offered the space                                                                                                                                                                                                |
| The tick on a reply and on a reservation     | Visa mitt namn för den som efterlyste platsen                                                                                                                                                                                         | Show my name to the person who posted the wanted ad                                                                                                                                                                                             |
| The page shown to a person it does not serve | Parkeringsdelning låter de som hör till huset låna ut och efterlysa parkeringsplatser. Den är inte tillgänglig för dig. Fråga styrelsen om du tycker att du borde ha tillgång.                                                        | Parking share lets the people connected to the house lend and ask for parking spaces. It is not available to you. Ask the board if you think you should have access.                                                                            |

### A name shown at its owner's choice

Each tick is the host's `showSubject` flag on the record (ADR 0053, "A name
shown at its subject's own choice"), not a field the plugin keeps:

- Offers, claims, wanted ads and replies declare `showsSubject`. The module
  sends `showSubject` from the tick on the person's own call. The host keeps it
  only when the call is the record's subject's own: a job, a support session
  and anybody else's call can neither set it nor clear it. The access report
  prints the flag with the record.
- On each read the host adds `shown`, the subject's name and, for a resident,
  their apartment, to a ticked record whose subject it still serves. The plugin
  shows that and nothing else, keeps it nowhere, and shows a ticked record
  without `shown` exactly as it shows an unticked one. So a name stops showing
  on the next read after its owner moves out, loses their class or the
  install's consent to it, while the offer or ad itself may still be listed. An
  owner who becomes protected, restricted or objecting takes the whole record
  out of what the plugin reads, as before.
- A mail names the other person from the same `shown`, read by the job when it
  runs.
- A reservation's claim is written by a job, so the host stores its flag as
  false and it never shows the poster's name. The holder sees the poster's
  name, where the poster ticked it, on the ad and for as long as the ad lasts.
  The holder's name on a reservation is the tick on the offer the holder's own
  call writes.

### Reserving for a poster

On a route a resident calls, a record may name only the caller or the person
the record it replaces is about (ADR 0051), so the holder's call cannot write
the poster's claim. It is done the way a cancelled claim's days are given back:
by a job that is handed no person id.

1. **The holder's call** names the ad by its key, one of the holder's own
   spaces, the days, and the holder's tick. The days must be days of the ad
   that are not past and that no reservation covers yet. The call refuses an ad
   the plugin cannot read on the route, so it accepts a key only for an ad the
   caller could have seen, and refuses the caller's own ad. It then writes,
   about the holder, a `pending` offer of the space for those days, carrying
   the ad's key, and the days' records, as any offer does, so of two offers of
   one day on one space only one holds it. It queues the job with the offer's
   key and the offer record's identity.
2. **The job** reads the offer and, through the key in it, the ad. It goes ahead
   only while the offer is still pending for this reservation, the ad can be
   read and is open, and the days are still the ad's and not covered. It then,
   in this order, marks the days covered on the ad, with a write conditional on
   the ad's revision, so that of two reservations of one day only one covers
   it; writes the claim about the ad's subject, keyed by the offer's id and
   round (`expectedRevision: null`, as every first claim on a round is);
   rewrites the days' records about the poster, as a claim does; and marks the
   offer claimed. The claim's subject is the subject of the ad record the job
   read, never a value from the job's data or the caller.
3. **The poster is mailed** by the same job, once the claim stands, at the
   address `residents()` or `nonResidents()` gives for the claim's subject: the
   space label, the days, and the holder's name when the holder ticked it. The
   job writes the `space-reserved` audit entry about the poster. The holder's
   call writes `offer-posted` about the holder.
4. **When the job cannot go ahead**, it takes the days back off the ad if it
   covered them, clears the pending offer as any leftover is cleared, and the
   holder's page says that the ad is no longer open. That answer is the same
   whether the ad was withdrawn, removed or erased, its poster has become
   withheld from the plugin, or the host refused the claim because the poster
   is no longer served (`PluginRecordSubjectError`). In the last case the job
   also closes the ad, so that it is no longer listed. A holder therefore learns
   nothing they would not learn from the ad leaving the list (ADR 0051, threat
   4). Days that another reservation covered first have an answer of their own,
   which says nothing about the poster.
5. **A retry** finds what an earlier run wrote, by the offer's round and the
   claim's key, and carries on from there, so a reservation makes at most one
   claim and sends at most one mail.
6. **The poster cancels** a reserved claim as any claim. The days go back to the
   holder through the job that does so for every claim, and the poster's own
   call takes them off the ad's covered days while the ad is there. Days a
   reservation never covered stay open on the ad throughout.

The covered days are an internal field on the ad, like `replyMails`: days and
claim keys, and no person id. The manifest does not declare it, and the access
report lists it as an unlabelled stored key.

## The entry in the record of processing activities

This is what the board reads on the data protection screen after installing, in
the association's language. The board's own edits there keep winning over it.

| Field                  | Swedish                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | English                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                   | Parkeringsdelning                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Parking share                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Purpose                | Låta den som har en parkeringsplats erbjuda den under en period när den inte används och en granne ta den, låta den som behöver en plats efterlysa en och den som har en svara eller reservera sin plats åt hen, samt ge styrelsen en översikt över platserna, erbjudandena, efterlysningarna och bokningarna.                                                                                                                                                                    | Let whoever holds a parking space offer it for a period when it is not used and a neighbour claim it, let somebody who needs a space post a wanted ad and a holder reply or reserve their space for them, and give the board an overview of the spaces, offers, wanted ads and claims.                                                                                                                                                                                                                      |
| Legal basis            | Berättigat intresse (art. 6.1 f).                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Legitimate interest (art. 6(1)(f)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Legitimate interest    | Att husets parkeringsplatser kommer till nytta när den som har en plats inte behöver den, genom att grannar kan låna ut och efterlysa platser sinsemellan, och att styrelsen kan hålla ordning på platserna och på det som läggs upp. Avvägning: ett namn visas bara för den som själv valt det. Efterlysningar och svar raderas 30 dagar efter sista dagen, övrigt ett år efter perioden. Skyddade personuppgifter, begränsad behandling och beviljad invändning lämnas utanför. | That the building's parking spaces are of use when whoever holds one does not need it, by letting neighbours lend and ask for spaces among themselves, and that the board can keep the spaces, and what is posted, in order. Balancing: a name is shown only where its owner chose to show it. Wanted ads and replies are erased 30 days after the ad's last day, other records a year after the period. People with protected personal data, under a restriction or with a granted objection are left out. |
| Data subjects          | Medlemmar, boende och tidigare boende.                                                                                                                                                                                                                                                                                                                                                                                                                                            | Members, residents and former residents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Personal data          | Namn, lägenhet, e-postadress, fritext.                                                                                                                                                                                                                                                                                                                                                                                                                                            | Name, apartment, email address, free text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Retention              | Ett erbjudande och en bokning raderas ett år efter den period de gäller. En efterlysning och svaren på den raderas 30 dagar efter efterlysningens sista dag, eller tidigare om den tas bort. En tilldelning av plats raderas senast fem år efter att den gjordes, eller tidigare om styrelsen tar bort den.                                                                                                                                                                       | An offer and a claim are erased a year after the period they cover. A wanted ad and the replies to it are erased 30 days after the ad's last day, or sooner if it is removed. An assignment of a space is erased five years after it was made at the latest, or earlier if the board removes it.                                                                                                                                                                                                            |
| Recipients             | Föreningens e-postleverantör, som tar emot modulens e-post för att leverera den. Förvaltaren, när styrelsen låter förvaltaren använda modulen: förvaltaren ser det som andra väljer att visa där, och föreningens personuppgiftsbiträdesavtal binder förvaltarens personal till tystnad och föreningens ändamål. Båda står i föreningens egen förteckning över mottagare.                                                                                                         | The association's mail provider, which receives the module's mails in order to deliver them. The property manager, where the board lets them use the module: they see what others choose to show there, and the association's processor agreement binds their staff to confidentiality and to the association's purpose. Both are named in the association's own list of recipients.                                                                                                                        |
| Third-country transfer | Modulen anropar ingen egen extern tjänst. Om e-postleverantören finns utanför EU/EES gäller de skyddsåtgärder som föreningen har antecknat för den.                                                                                                                                                                                                                                                                                                                               | The module calls no external service of its own. If the mail provider is outside the EU/EEA, the safeguards the association has recorded for it apply.                                                                                                                                                                                                                                                                                                                                                      |

Two rows depend on the callers the module serves besides residents (see "The
declaration for the manifest"):

- **Data subjects.** Once the module declares them, the host adds the categories
  from the declared classes (ADR 0053, "The data subjects"): `board` adds board
  members, and `administrator`, `propertyManager` and `pluginAccess` add people
  outside the association. The row then reads "Medlemmar, boende, tidigare
  boende, styrelseledamöter och personer utanför föreningen." and "Members,
  residents, former residents, board members and people outside the
  association."
- **Recipients.** The property manager is a recipient the manifest cannot
  declare: `recipients` names the places a plugin connects to, and the property
  manager is a person who signs in. So the row above is the wording the board
  adds, in the record and in its own list of recipients, when it lets the
  property manager use the module. The privacy notice follows the record (GDPR
  art. 13(1)(e)). The core cannot check the processor agreement; the board
  checks that it covers what the property manager's staff see here, whether
  they use the module in their work for the association or for their own use.

The legal basis is legitimate interest, as for digital signage
([ADR 0034](adr/0034-digital-signage-on-the-public-plugin-api.md)), and not the
contract that bookings of shared resources rest on: sharing a space with a
neighbour is an optional service beside the membership, not part of it. The
legitimate interest row is the text the manifest carries as
`legitimateInterest`, which the record keeps as the note on the legal basis and
the consent screen shows after the basis (ADR 0035). The basis has two
consequences, both decided and set out below: a granted objection keeps the
person refused, and the portability export carries none of the records.

Three things in the row are the platform's and not the plugin's to choose:

- **Erasure on request.** A granted erasure request deletes the person's
  records in all six collections at the next run of the host's purge, and the
  closing job does not close the request while one is left (ADR 0047). A legal
  hold or a restriction keeps them.
- **Restriction, protected personal data and objection.** A person with
  protected personal data, a person under a restriction and a person with a
  standing objection to this processing never appear in what the plugin reads.
  They cannot offer, claim, post a wanted ad, reply or reserve, and the plugin
  tells them only that the module is not available to them and that they can
  ask the board. A person who already has an offer, a claim, a wanted ad, a
  reply or an assignment and becomes one of these has those records hidden from
  the plugin, while a person who moves out keeps theirs visible, so the plugin
  can tell the two apart, though not which of the three it is (ADR 0047).
  Because the processing rests on legitimate interest, every person it concerns
  can object to it (GDPR art. 21), and the board grants the objection on the
  data protection screen (ADR 0035).
- **The access report.** Each record is printed on the person's data subject
  access report under the collection's title, whether the plugin is running,
  switched off or removed. The portability export carries none of them while
  the processing rests on legitimate interest (ADR 0047).

The portability export carries none of these records: it carries a plugin's
records only when its processing rests on consent or the contract (ADR 0047).
The access report still prints them in full.

## The declaration for the manifest

```jsonc
{
  "openbrf": {
    "id": "parking-share",
    "personalData": ["name", "apartment", "email", "freeText"],
    "processing": {
      "purpose": {
        "sv": "Låta den som har en parkeringsplats erbjuda den under en period när den inte används och en granne ta den, låta den som behöver en plats efterlysa en och den som har en svara eller reservera sin plats åt hen, samt ge styrelsen en översikt över platserna, erbjudandena, efterlysningarna och bokningarna.",
        "en": "Let whoever holds a parking space offer it for a period when it is not used and a neighbour claim it, let somebody who needs a space post a wanted ad and a holder reply or reserve their space for them, and give the board an overview of the spaces, offers, wanted ads and claims.",
      },
      "legalBasis": "legitimateInterest",
      "legitimateInterest": {
        "sv": "Att husets parkeringsplatser kommer till nytta när den som har en plats inte behöver den, genom att grannar kan låna ut och efterlysa platser sinsemellan, och att styrelsen kan hålla ordning på platserna och på det som läggs upp. Avvägning: ett namn visas bara för den som själv valt det. Efterlysningar och svar raderas 30 dagar efter sista dagen, övrigt ett år efter perioden. Skyddade personuppgifter, begränsad behandling och beviljad invändning lämnas utanför.",
        "en": "That the building's parking spaces are of use when whoever holds one does not need it, by letting neighbours lend and ask for spaces among themselves, and that the board can keep the spaces, and what is posted, in order. Balancing: a name is shown only where its owner chose to show it. Wanted ads and replies are erased 30 days after the ad's last day, other records a year after the period. People with protected personal data, under a restriction or with a granted objection are left out.",
      },
      "retention": {
        "sv": "Ett erbjudande och en bokning raderas ett år efter den period de gäller. En efterlysning och svaren på den raderas 30 dagar efter efterlysningens sista dag, eller tidigare om den tas bort. En tilldelning av plats raderas senast fem år efter att den gjordes, eller tidigare om styrelsen tar bort den.",
        "en": "An offer and a claim are erased a year after the period they cover. A wanted ad and the replies to it are erased 30 days after the ad's last day, or sooner if it is removed. An assignment of a space is erased five years after it was made at the latest, or earlier if the board removes it.",
      },
      "dataSubjects": ["members", "residents"],
    },
    "personRecords": [
      {
        "collection": "assignments",
        "titleKey": "records.assignments.title",
        "personalData": ["apartment"],
        "keepAtMostDays": 1830,
        "fields": [{ "key": "space", "labelKey": "records.assignments.space" }],
      },
      {
        "collection": "offers",
        "titleKey": "records.offers.title",
        "personalData": ["apartment"],
        "keepAtMostDays": 730,
        "fields": [
          {
            "key": "space",
            "labelKey": "records.offers.space",
            "provided": true,
          },
          {
            "key": "from",
            "labelKey": "records.offers.from",
            "provided": true,
          },
          { "key": "to", "labelKey": "records.offers.to", "provided": true },
          { "key": "status", "labelKey": "records.offers.status" },
        ],
      },
      {
        "collection": "days",
        "titleKey": "records.days.title",
        "personalData": ["apartment"],
        "keepAtMostDays": 366,
        "fields": [
          {
            "key": "space",
            "labelKey": "records.days.space",
            "provided": true,
          },
          { "key": "day", "labelKey": "records.days.day", "provided": true },
        ],
      },
      {
        "collection": "claims",
        "titleKey": "records.claims.title",
        "personalData": ["apartment"],
        "keepAtMostDays": 730,
        "fields": [
          {
            "key": "space",
            "labelKey": "records.claims.space",
            "provided": true,
          },
          {
            "key": "from",
            "labelKey": "records.claims.from",
            "provided": true,
          },
          { "key": "to", "labelKey": "records.claims.to", "provided": true },
          { "key": "status", "labelKey": "records.claims.status" },
        ],
      },
      {
        "collection": "wanted-ads",
        "titleKey": "records.wanted-ads.title",
        "personalData": ["apartment", "freeText"],
        "keepAtMostDays": 395,
        "fields": [
          {
            "key": "from",
            "labelKey": "records.wanted-ads.from",
            "provided": true,
          },
          {
            "key": "to",
            "labelKey": "records.wanted-ads.to",
            "provided": true,
          },
          {
            "key": "note",
            "labelKey": "records.wanted-ads.note",
            "provided": true,
          },
        ],
      },
      {
        "collection": "replies",
        "titleKey": "records.replies.title",
        "personalData": ["freeText"],
        "keepAtMostDays": 395,
        "fields": [
          { "key": "wantedAd", "labelKey": "records.replies.wantedAd" },
          {
            "key": "note",
            "labelKey": "records.replies.note",
            "provided": true,
          },
        ],
      },
    ],
  },
}
```

The declaration above is what the plugin SDK accepts today. The release of the
SDK and the core that carries
[ADR 0053](adr/0053-people-a-resident-route-serves-who-do-not-live-here.md)
adds three things to it, and the module declares them against that release
(see "Who uses the module"):

```jsonc
{
  "openbrf": {
    "nonResidentCallers": [
      "board",
      "administrator",
      "propertyManager",
      "pluginAccess",
    ],
    "view": { "section": "building", "offeredTo": "signedIn" },
    // and on each of offers, claims, wanted-ads and replies:
    "personRecords": [{ "collection": "offers", "showsSubject": true }],
  },
}
```

Until then the module serves only the residents the address book lists, and
shows nobody's name on a route a resident calls. The SDK's test reads the first
block on this page, so the change that adds these to the SDK moves them into it.

Why the declaration is what it is:

- **`personalData` has four categories.** `name` and `apartment` are what the
  board's overview shows, what the host shows of a person who chose to be named,
  and what the address book gives for the caller. `email` is the address a mail
  is sent to, read with `addressBook:readContact`. `freeText` is the note on a
  wanted ad and on a reply, which the person writes and which may name anybody.
  `residency` is not declared: the plugin never reads or stores a move-in or
  move-out date, only what `caller` answers about the person calling.
- **The legal basis is legitimate interest.** The core's bookings rest on the
  contract because booking a shared resource is part of what a member or
  resident is entitled to. Lending a parking space between neighbours is not
  part of the membership, so the contract does not cover it, and consent would
  make a withdrawal end a claim another person relies on. Legitimate interest
  needs the interest stated, which the privacy notice must give (art. 13(1)(d)),
  and gives every person concerned the right to object, which the host carries
  out (ADR 0035).
- **A collection declares only `apartment` beside `freeText`.** ADR 0047 lets a
  collection name only the manifest's own categories. The list of categories
  is published ([plugin contract](plugin-contract.md) and the SDK's
  `permissions.ts`), but it has none for a parking space or a period, so a
  record's space and dates have no category of their own. Such categories
  would take a further extension of that list: the broker package's gap G11
  proposes sharing the existing category enum, which has neither. A space is
  tied to an apartment by whoever holds it, so `apartment` is the nearest
  (consistent with ADR 0047). A wanted ad's dates are declared the same way,
  and its note as `freeText`. A reply holds a note and no dates, so it declares
  `freeText` alone.
- **`keepAtMostDays` for offers and claims is 730.** A record is erased a year
  after its period ends, and the plugin refuses an offer whose last day is more
  than 365 days after the day it is posted, so the longest `eraseOn` is
  365 + 365 days from the write. A reservation's claim is written on a day the
  ad was open, so its last day is no further away than the ad's.
- **`keepAtMostDays` for days is 366.** A day's record is erased the day after
  its day and the plugin refuses an offer whose last day is more than 365 days
  after the day it is posted, so the longest `eraseOn` is 365 + 1 days from the
  write. This is sooner than the offer or claim the day belongs to, so
  "a year after the period they cover" in the retention text stays an upper
  bound for every record the plugin keeps about offers and claims.
- **`keepAtMostDays` for wanted ads and replies is 395.** An ad is erased 30
  days after its last day, which is at most 365 days after the day it is posted,
  so the longest `eraseOn` is 365 + 30 days from the write. A reply takes its
  ad's erase date, and is written on or after the day the ad was posted.
- **`keepAtMostDays` for assignments is 1 830,** the longest ADR 0047 allows.
- **Only a person's own choices are `provided`.** The space, the days and a note
  are what the holder, the claimer, the poster or the replying holder chose.
  Whether they show their name is their choice too, but the host keeps it as a
  flag beside the record and not as a field (ADR 0053). A status the plugin
  sets, an assignment the board made, and the ad a reply belongs to are not.
  Under legitimate interest the portability export carries none of them; the
  marking keeps the declaration true of what the person gave if the basis is
  ever changed. The marking is per field of a collection, not per record, so it
  overstates one case: on a claim that a reservation wrote for a poster, the
  holder picked the space and the days within the ad's, and the poster only
  asked for the days of the ad. The claim stays `provided` because an ordinary
  claim's space and days are its claimer's own choice. If the basis is changed
  to one that needs the portability export, the export has to leave those fields
  out for a reserved claim, or the claim has to say how it came about, before
  the module is released on it.
- **`legalBasis` is `legitimateInterest`, with the interest.** The manifest
  schema refuses a processing on legitimate interest that names no interest,
  and an interest named on any other basis. The text is the legitimate interest
  row above, word for word. The schema takes at most 500 characters in each
  language, so an edit to the row keeps within that.
- **The plugin declares no `network` hosts and no secret settings** (ADR 0037),
  so it makes no outbound request of its own. That does not rule out a
  recipient: `host.mail` sends through the instance's configured SMTP server
  (plugin contract, permissions), which the core's own processing rows already
  name as a recipient. The recipients and third-country rows therefore point at
  the association's mail provider and the location and safeguards recorded for
  it, and promise nothing about where it is.

## The consent screen

Before anything is downloaded the board reads the permissions, the categories
and, for each collection, its categories and its bound (ADR 0047). The copy the
module supplies for them is below. The permission names are the plugin's
manifest `permissions`, shown by the host and not worded by the plugin.

| Shown                    | Value                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Permissions              | `addressBook:read`, `addressBook:readContact`, `mail:send`, `jobs:schedule`                     |
| Actions `offer`, `claim` | Capability `self:manage`, effect `write`, apartment                                             |
| Resident routes          | `me`: see your own parking space, offers and claims                                             |
|                          | `offers`: offer your parking space for some days, and claim a neighbour's                       |
|                          | `wanted-ads`: ask for a parking space, and reply to a neighbour who asks                        |
| Personal data            | Name, apartment, email address, free text                                                       |
| Collection `assignments` | Apartment. Kept at most 1 830 days.                                                             |
| Collection `offers`      | Apartment. Kept at most 730 days.                                                               |
| Collection `days`        | Apartment. Kept at most 366 days.                                                               |
| Collection `claims`      | Apartment. Kept at most 730 days.                                                               |
| Collection `wanted-ads`  | Apartment, free text. Kept at most 395 days.                                                    |
| Collection `replies`     | Free text. Kept at most 395 days.                                                               |
| Legal basis              | Legitimate interest (art. 6(1)(f)), followed by the interest: the legitimate interest row above |

The resident routes are shown under "Residents can use this plugin" by their
titles, which the catalog entry carries in Swedish and English (ADR 0051). An
install that consented before the plugin declared them consented to none, and
the host refuses to load the version that declares them until the board
consents again. The same holds for the version that adds `wanted-ads`, `replies`
and `freeText`: it widens what the plugin handles, so the host refuses to load
it as `personal-data-widened` until the board consents to it (ADR 0047).

The version that declares `nonResidentCallers` and `showsSubject` is refused in
the same way, as `resident-routes-widened` and `personal-data-widened`, until
the administrator consents. The core writes the text for each class (ADR 0053,
"The consent screen"): that the module also serves the classes it declares, on
the same routes and held to the same rules; that it can read their names and
contact details off those routes; that they see what residents show; and that
the property manager is an external party whom the association's processor
agreement has to bind. For each collection that declares `showsSubject` the
screen says that it may show a person's name, and a resident's apartment, to
those the module serves, when that person chooses.

The actions `offer` and `claim` are declared for the surfaces `ui` and `ai`.
They are proposals: the AI package reaches them only once an administrator has
armed them, and its writes are held as pending changes. Connected apps (`mcp`)
do not get them. Wanted ads and replies have no action: a note is written by the
person it is from, on the page.

The plugin's description in the catalog entry, which the consent screen shows
beside these, says what the board is agreeing to in a form a resident can be
given:

> **English.** Parking share lets whoever holds a parking space offer it for a
> period when they will not use it, and lets a neighbour claim it. Somebody who
> needs a space can post a wanted ad with the days and a short note, and a
> holder can reply to it or reserve their space for them. The board assigns
> each space, sees every offer, claim, wanted ad and reply, and can remove an ad
> or a reply. Besides residents, the board can let board members who live
> elsewhere, the administrator, the property manager and people it gives
> access, such as somebody who rents a garage, use the module. Everybody who
> uses it sees a space and its days, and a wanted ad's days and note, but not
> who is behind them unless that person chooses to show it. The
> module mails confirmations, mails a poster about replies, reservations, and
> the removal of their ad or of a reply to it, and mails a holder whose reply
> the board removes. It handles no payment. Offers and claims are erased a year
> after the period they cover, and wanted ads and their replies 30 days after
> the ad's last day. The board's assignment of a space is kept for up to five
> years, or until the board removes it. The module rests on the association's
> legitimate interest, so anybody can object to it; once the board grants the
> objection, the module no longer sees them and they can no longer use it.
> Two things to tell residents: an offer shows that a space is free on certain
> days, so a neighbour who knows whose space it is can tell the household is
> away; and everybody who uses the module, the property manager included,
> reads the note on a wanted ad, so it should not name anybody else.

> **Svenska.** Parkeringsdelning låter den som har en parkeringsplats erbjuda
> den under en period när den inte används, och låter en granne ta den. Den som
> behöver en plats kan efterlysa en med dagarna och ett kort meddelande, och den
> som har en plats kan svara eller reservera sin plats åt hen. Styrelsen
> tilldelar platserna, ser alla erbjudanden, bokningar, efterlysningar och svar,
> och kan ta bort en efterlysning eller ett svar. Förutom de boende kan
> styrelsen låta styrelseledamöter som bor någon annanstans, administratören,
> förvaltaren och personer den ger tillgång, till exempel den som hyr ett
> garage, använda modulen. Alla som använder den ser en plats och dess dagar,
> och en efterlysnings dagar och meddelande, men inte vem det gäller om inte den
> personen väljer att visa det. Modulen skickar bekräftelser med
> e-post, och e-post till den som efterlyst en plats om svar, reservationer och
> borttagning av efterlysningen eller av ett svar på den, och till den vars
> svar styrelsen tar bort. Ingen betalning hanteras. Erbjudanden och bokningar
> raderas ett år efter den period de gäller, och efterlysningar och svaren på dem 30
> dagar efter efterlysningens sista dag. Styrelsens tilldelning av en plats
> sparas i upp till fem år, eller tills styrelsen tar bort den. Modulen bygger
> på föreningens berättigade intresse, så vem som helst kan invända mot den;
> när styrelsen beviljar invändningen ser modulen inte längre personen, som då
> inte heller kan använda den.
> Två saker att berätta för de boende: ett erbjudande visar att en plats är
> ledig vissa dagar, så en granne som vet vems plats det är kan se att hushållet
> är bortrest; och alla som använder modulen, även förvaltaren, läser
> meddelandet i en efterlysning, så det bör inte nämna någon annan.

## Text keys

The keys are in the plugin's own namespace, as everywhere in the manifest. The
audit events are shown in the audit log through `audit.<event>` (ADR 0035).

| Key                         | Swedish                                    | English                                  |
| --------------------------- | ------------------------------------------ | ---------------------------------------- |
| `records.assignments.title` | Tilldelad parkeringsplats                  | Assigned parking space                   |
| `records.assignments.space` | Plats                                      | Space                                    |
| `records.offers.title`      | Erbjuden parkeringsplats                   | Offered parking space                    |
| `records.offers.space`      | Plats                                      | Space                                    |
| `records.offers.from`       | Första dag                                 | First day                                |
| `records.offers.to`         | Sista dag                                  | Last day                                 |
| `records.offers.status`     | Status                                     | Status                                   |
| `records.days.title`        | Dag för en erbjuden parkeringsplats        | Day of an offered parking space          |
| `records.days.space`        | Plats                                      | Space                                    |
| `records.days.day`          | Dag                                        | Day                                      |
| `records.claims.title`      | Tagen parkeringsplats                      | Claimed parking space                    |
| `records.claims.space`      | Plats                                      | Space                                    |
| `records.claims.from`       | Första dag                                 | First day                                |
| `records.claims.to`         | Sista dag                                  | Last day                                 |
| `records.claims.status`     | Status                                     | Status                                   |
| `records.wanted-ads.title`  | Efterlysning av parkeringsplats            | Wanted ad for a parking space            |
| `records.wanted-ads.from`   | Första dag                                 | First day                                |
| `records.wanted-ads.to`     | Sista dag                                  | Last day                                 |
| `records.wanted-ads.note`   | Meddelande                                 | Note                                     |
| `records.replies.title`     | Svar på en efterlysning av parkeringsplats | Reply to a wanted ad for a parking space |
| `records.replies.wantedAd`  | Efterlysning                               | Wanted ad                                |
| `records.replies.note`      | Meddelande                                 | Note                                     |
| `audit.space-assigned`      | Plats tilldelad                            | Space assigned                           |
| `audit.space-unassigned`    | Tilldelning borttagen                      | Assignment removed                       |
| `audit.offer-posted`        | Plats erbjuden                             | Space offered                            |
| `audit.offer-withdrawn`     | Erbjudande återtaget                       | Offer withdrawn                          |
| `audit.space-claimed`       | Plats tagen                                | Space claimed                            |
| `audit.claim-cancelled`     | Bokning avbruten                           | Claim cancelled                          |
| `audit.wanted-ad-posted`    | Plats efterlyst                            | Wanted ad posted                         |
| `audit.wanted-ad-withdrawn` | Efterlysning återtagen                     | Wanted ad withdrawn                      |
| `audit.wanted-ad-removed`   | Efterlysning borttagen av styrelsen        | Wanted ad removed by the board           |
| `audit.reply-posted`        | Svar lämnat                                | Reply posted                             |
| `audit.reply-withdrawn`     | Svar återtaget                             | Reply withdrawn                          |
| `audit.reply-removed`       | Svar borttaget av styrelsen                | Reply removed by the board               |
| `audit.space-reserved`      | Plats reserverad                           | Space reserved                           |

An audit entry names the person it is about through `subject`, and its detail
holds the space label and the dates, never a name, an apartment, an address or
a note.

## What the plugin has to do to match

Each line is a rule the declaration relies on. A review of the plugin checks it
against the code.

1. An offer or a claim is written with `eraseOn` one year after its last day,
   and a wanted ad and a reply as rule 14 says, and
   `host.personRecords` is the only place a person's id and a date are kept
   together. Nothing about a person goes in `host.records` or in the plugin's
   settings.
2. An offer whose last day is more than 365 days after the day it is posted is
   refused with a message, not shortened.
3. A person offers, claims, posts, replies and reserves only as
   `host.addressBook.caller` answers them `listed` or `nonResident`. A caller
   who is `notListed` gets the one text in "What the page tells a person before
   they act" for every reason, as ADR 0047 requires, and cannot act. The
   resident routes are the manifest's, `me`, `offers` and `wanted-ads` (ADR
   0051): the host answers them only for a person it serves (ADR 0053), and
   there the plugin reads no list of people and names in a record only the
   caller or the person the record it replaces is about. Assigning a space is
   the board's and is not gated on `caller`: the route requires the
   `bookings:configure` capability (`@RequireCapability`), which the board and
   the administrator hold, and its picker lists `residents()` and
   `nonResidents()`. The person a space is assigned to is checked by the host,
   which refuses a new subject it does not serve with
   `PluginRecordSubjectError`, and by the plugin when the board assigns a space
   again to its holder, so that a former resident's record is not renewed.
4. The list of open offers carries a space label and dates, and the holder's
   name only as the host's `shown`. To a `nonResident` caller it lists only the
   offers with a day in the span the caller asks for, of at most 31 days, and
   only their days in that span. The list of wanted ads carries the dates and
   the note, and the poster's name and apartment only as `shown`. Neither
   carries a person id, nor a name or an apartment the host did not give as
   `shown`, in the response or in anything else the page loads, and a ticked
   record without `shown` is rendered exactly as an unticked one.
5. A confirmation mail names the space and the days, and greets the recipient by
   their own name. It names the other person only by the `shown` the job reads
   with the record, and never gives an address or telephone number. The holder
   and the claimer never share one mail. The job that sends it is handed no
   person id, and mails nobody about a claim record other than the one its act
   was recorded on. The job that gives a cancelled claim's days back is handed
   no person id either: it names the holder only as the subject of the offer it
   reads.
6. The first claim wins, and the store refuses the second with a conflict on
   the claim's key, which is the offer's id and its round
   (`expectedRevision: null`), not a check the plugin makes first.
7. Withdrawing an offer and cancelling a claim set a status and keep the record
   to its date. They do not call `delete`, so the audit entry and the access
   report agree about what happened. A withdrawn offer can be opened again: the
   record is rewritten to `pending` and then `open` on a new round, with the
   same erase date, and the audit log keeps every posting and withdrawal.
   Nothing is deleted, but the status can change again. An offer is written
   `pending` and set open only after its checks pass; a pending offer is neither
   listed nor claimable, and one left behind by a failed call stays hidden and
   unclaimable. It may remain until its erase date unless the plugin clears it
   sooner, for example when a call recovers it or when the space's assignment is
   removed. Clearing deletes a leftover of an offer posted for the first time
   and sets a leftover of a reopened offer back to `withdrawn`.
8. The plugin makes no outbound request of its own (mail goes through
   `host.mail`) and stores no name, address or
   telephone number it read from the address book.
9. An offer's key is an id the plugin makes, not the holder's person id. A
   claim carries that key, and the claimer's access report prints the claim in
   full, so the holder must not be readable off it. The same holds for a wanted
   ad: its key is an id the plugin makes, because a reply carries it and the
   replying holder's access report prints it. The host refuses a record whose
   key or value holds another person's id with `PluginRecordOtherPersonError`.
10. A new offer is refused when the person already has 50 offers pending or
    open up to their last day, or 50 withdrawn offers; a new claim is refused
    when they already have 30 active claims up to their last day or 50
    cancelled claims; a new wanted ad is refused when they already have 10
    wanted ads up to their last day. The check runs before anything is written.
    The mail a reply sends is bounded by rule 19, not by these thresholds.
    Reopening a withdrawn offer adds no record, so the withdrawn-offer threshold
    does not apply to it. Withdrawing and cancelling are never refused, so these
    are thresholds for admitting new records, not maxima for the records kept,
    and instances of the plugin writing at the same time can each pass one once
    more.
11. A day's record is written with `eraseOn` the day after its day, never
    later, and the plugin never deletes it. A claim rewrites it about the
    claimer before the offer is marked claimed, and does not stand when it
    cannot, so no claimed day is left only in records about a person who can be
    erased. A cancelled claim gives the record back to the holder when the
    offer can be read, the holder named, and the claimer not withheld from the
    plugin by the time the days go back. Otherwise the record keeps the
    claimer as its subject, with the claim's key cleared, until the host erases
    it or another offer takes it over, so it is on the claimer's access report
    and covered by the claimer's erasure request, not the holder's. The record
    names no person: its value holds the space's label, the day, the offer's id
    and the claim's key.
12. A space's record counts its assignments and says whether the latest stands,
    and says nothing about who holds the space. Each new assignment takes the
    next number as its key.
13. `showSubject` is sent `true` only from a tick that is off until the person
    ticks it, on their own offer, claim, wanted ad or reply, and its label is
    the one in "What the page tells a person before they act". The plugin
    copies `shown` into no record, setting, cache, memory or later response. A
    reservation's claim is written by a job and shows no name.
14. A wanted ad's last day is at most 365 days after the day it is posted, and
    one further away is refused with a message, not shortened. The ad is written
    with `eraseOn` 30 days after its last day, and each of its replies with the
    ad's `eraseOn`. A note is at most 200 characters, trimmed, and an empty one
    is stored as no note.
15. A reply is shown to the holder who wrote it, to the ad's poster and to the
    board, and to nobody else. Its key is the ad's id and the holder's own id,
    so a holder has one reply to an ad and writing again changes it. What the
    poster's page loads of a reply carries neither its key nor any person id.
16. A reservation's offer is written `pending` by the holder's own call, so it
    is never open to anybody else, and only for an ad the plugin can read on
    that call. Its claim is written by a job handed no person id, which names
    the poster only as the subject of the ad it reads, and only for days the ad
    asks for that no other reservation covers: the job marks them covered on
    the ad with a write conditional on the ad's revision before it writes the
    claim. A reservation the job cannot complete leaves no claim and no covered
    days, its pending offer is cleared as any leftover is, and the holder is
    told the same whatever the reason the ad could not be used. A retried job
    makes at most one claim and sends at most one mail. The module's tests show
    each of these, and that two reservations of one day of one ad leave one
    claim, and fail when the conditional write is taken out.
17. A poster's withdrawal deletes the ad and its replies. The board's removal
    deletes the ad and its replies, or the reply, and writes an audit entry
    about the person who wrote what it removed, with the board member as the
    actor. It mails the poster of the ad, whether it removed the ad or only a
    reply to it, and, when it removed a reply, mails the holder who wrote the
    reply in a mail of their own. A holder's withdrawal of a reply clears its
    note and marks it withdrawn, and the record is erased with the ad.
18. A note goes in no audit entry, log line, job's data or `host.records`
    record, and a mail carries it only to the poster of the ad it replies to.

19. A reply sends the poster at most one mail for each holder and ad while the
    holder's reply record lasts, and the ad's replies at most 10 mails in all
    (erasing the holder's records clears the holder's flag, not the ad's count). Changing a reply, and withdrawing
    it and replying again, send none. The budget is spent by the conditional
    write that creates the reply or turns a withdrawn one live while `mailed` is
    not set, and by the matching increment of the ad's `replyMails`; of writes
    at the same time only one takes a unit, and a unit is never given back by
    a withdrawal, a failed queueing or a failed send. The job is handed no
    person id, mails nobody for a reply that is withdrawn, removed or erased,
    and mails at most once however often it is retried. The board's removal
    mails are not drawn from this budget.
20. The module's tests show rule 19: repeated edits of a reply send one mail in
    all; withdrawing and replying again sends none; concurrent first replies by
    one holder send one mail, and concurrent replies by different holders to one
    ad send no more than 10 in all; a job that runs again, or two that run at
    once, for one reply mails once, and mails nobody for a reply withdrawn
    before it runs; a holder whose records were erased and who replies again is
    held by the ad's count; and each test fails when the budget's conditional
    write is taken out.
21. The page gives the text in "What the page tells a person before they act"
    before a person offers, posts, replies or ticks a box, and on the page shown
    to a person it does not serve. Where it names who will see something, it
    names every class the manifest declares.

## Open points

1. **The legal basis.** **Decided** by the board on 2026-11-02: legitimate
   interest, as digital signage uses (ADR 0035), with the interest stated above.
   The contract follows the core's bookings, which a member or resident is
   entitled to, and lending a space between neighbours is not part of the
   membership; consent would make a withdrawal end a claim another person relies
   on. The portability export therefore carries none of the module's records
   (ADR 0047). A lawyer reviews the basis and the stated interest before an
   association uses the module for real.
2. **Where the space-to-person assignment lives.** **Decided**: it stays the
   `assignments` person collection with the holder as subject, because an
   apartment id tied to a space says who the holder is and ADR 0033 keeps
   `host.records` free of that. The cost is that the record goes when the
   holder is erased, moves out and is no longer rewritten, or after 1 830 days,
   and the board then assigns the space again. A space label alone with no
   holder would leave the module unable to know who may offer what.
3. **The offer reveals absence, and who is named.** The module shows neighbours
   a label and dates, but a label that the car park's own signs show is enough
   for a neighbour to know whose space it is. The consent copy says so.
   **Decided** in the plugin's view: offers show the label to every person the
   module serves, since a neighbour cannot choose a space they cannot
   recognise, and the holder is told before they offer that neighbours will see
   the label and the days and that someone who knows whose space it is can tell
   it is free. Hiding the label until an offer is opened, or showing offers only
   to people without a space, would add steps without hiding who is away from
   anyone who looks. The earlier rule that the holder and the claimer are never
   named to each other is replaced: unnamed stays the default, and each side
   may choose to be named, as may a poster and a replying holder.
4. **Former residents.** A person who has moved out keeps their records to the
   erase date and they appear on their access report, so the record of
   processing has to name former residents. **Decided** on 2026-11-02 for every
   plugin (ADR 0035, "Former residents"): `dataSubjects` gains
   `formerResidents`, and the host adds it to the consent screen and the row
   for any plugin that declares `personRecords`, so this module, installed or
   updated on a release that carries it, has a row naming members, residents
   and former residents without a change to its declaration. The declaration
   above leaves it out on purpose: an instance released before the value
   refuses a manifest that uses it, and the whole catalog index if the entry
   does. The module can name it once the instances it serves run a release that
   knows it.
5. **The categories.** `apartment` stands in for a space and a date range
   because the published list of categories has none for either. It changes
   when that list gains them (ADR 0047, "Consequences").
6. **Checked by the build.** **Closed.** `parsePluginPackage` in
   `@openbrf/plugin-sdk` reads `processing` (since 1.3.0) and `personRecords`
   (since 1.5.0), strictly, so a misspelled field is refused. The SDK's tests
   parse the declaration on this page, so it cannot drift from the schema
   unnoticed, and check that every text key it names is in the table above.
7. **Who may act beyond the residents the address book lists.** **Decided** by
   [ADR 0053](adr/0053-people-a-resident-route-serves-who-do-not-live-here.md),
   which amends ADR 0051: the module declares four classes of caller, the host
   decides membership from its own records, the three refusals are tested
   first, and a former resident is in no class. See "Who uses the module" for
   what each person can do, how a person who does not live here gets an
   account, and what a caller outside the house sees; and "Reserving for a
   poster" for the reservation's job. The property manager stands with the
   conditions ADR 0053 sets: the recipients row above, the processor agreement,
   and ticks that are off by default and name them. The module takes these up
   once the core and SDK release that carries the ADR exists.
8. **How a chosen name reaches another person's screen.** **Decided** by ADR
   0053: the host keeps the subject's tick as a flag beside the record and adds
   the name, and a resident's apartment, on each read while the subject is
   served. The plugin never reads or keeps the name on a route a resident
   calls. See "A name shown at its owner's choice".
