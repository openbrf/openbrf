# ADR 0053: People a resident route serves who do not live here

Date: 2026-11-02

## Status

Accepted. Amends [ADR 0051](0051-resident-routes-in-a-plugin-that-reads-the-register.md)
in four places: "Only a listed caller", which person a resident route answers;
"The view and the navigation", who is offered its view; "The consent screen";
and "What catalog review reads", including its bullet "What reaches it from
elsewhere". Amends
[ADR 0047](0047-a-plugin-s-records-about-a-person.md) in two places: its
subject rule ("Which person a plugin may name") off resident routes, and "The
record refers to the register and does not copy it", which gains one way for a
record's subject to have their name shown (see "A name shown at its subject's
own choice"). It also amends how the host fills in the data subjects of a
plugin's processing declaration
([ADR 0035](0035-a-plugin-s-processing-and-objecting-to-it.md)). Changes the
glossary rows _property manager_ and _resident route_, and adds _plugin access_.

The rules of ADR 0051 that this record does not name stand as they are: the
floor by containment, the seal, the scope and the narrowed host object, the
hold, the deadline and the request context.

## Context

A resident route answers only a caller whom the address book lists to its
plugin (ADR 0051, "Only a listed caller"). That one check refuses six kinds of
caller with the same 403 and reason `resident-route-not-listed`:

1. a board member or administrator who does not live in the house;
2. the property manager;
3. a former resident whose account outlived their residency;
4. a person with protected personal data;
5. a person under a restriction (GDPR art. 18);
6. a person who objected to the plugin's processing (art. 21, ADR 0035).

The first three are refused because they hold no residency today. The last
three are refused because the address book withholds them from every plugin.
The two reasons share one check because, for parking share, both answers were
"no".

The board now wants parking share to serve more people, and has decided who:

- **Act** (offer, claim, post a wanted ad, reply, reserve): residents, as
  today; board members and administrators who do not live in the house; space
  holders who live elsewhere, such as somebody who rents a garage; and the
  property manager.
- **See the page and do nothing:** a former resident. The page says what the
  function is and that it is for people connected to the house.
- **Refused as today, with the same wording that gives no reason:** a person
  with protected personal data, under a restriction, or who objected to the
  plugin's processing. An objection to a processing that rests on legitimate
  interest has to be honoured, and the board accepted this.
- **See the page:** everybody signed in.

So the first three callers above split. Some of them become people the plugin
serves, and the other three refusals have to stay exactly as they are. The
other pieces the host refuses these people today follow from the same check:

- `caller` answers them `notListed`, so a plugin cannot tell who they are.
- A record about a person needs a subject that `residents()` would list (ADR
  0047). So the board's assignment of a space to a garage renter is refused, as
  is a record the garage renter would write about themselves.
- `residents()` does not list them, so a job has no address to mail them at.
- The account request is for "a person who lives in the cooperative"
  (GLOSSARY.md), so a garage renter has no form to ask for an account on.
- `dataSubjects` offers `members` and `residents`, and the people above are
  neither.

Two facts of the core bound the design.

**Every account already has a person.** `User.personId` is required. A board
member who lives elsewhere, an administrator, the property manager and a person
the board added to the address book without a residency are each a `Person`
row with an id, a name and, usually, an email address. The access report
(`DataSubjectReport`) and erasure work by person and not by residency. So such
an account needs no new kind of subject. The rules that refuse its person id
are what has to change.

**The host holds no parking spaces.** Which person holds which space is a
record the plugin writes about that person (`assignments` in parking share). It
is written from a board route, but the plugin's code writes it, and the host
cannot tell an assignment from any other record. A rule that served "a space
holder" would have the plugin decide whom the host serves.

The glossary row for the property manager reads "External role with access to
issue handling only, never the address book." The board chose to include them
after being told that this lets an outside party read, on a named wanted ad,
the name and apartment of the resident who posted it. The board asked for a
review that says what that takes, and for the matter to go back to the board if
it cannot stand.

## Threat model

ADR 0051's threats 1 to 6 hold for every caller a resident route serves, and
this record does not change how the host meets them. Three more come with
callers who do not live here.

7. **Who is served is an answer as well.** Any new answer that says whether a
   person is served, such as a refusal, a `caller` kind, a list, a subject that
   is accepted or a navigation entry, could tell somebody whether _another_
   person is listed. That is the question ADR 0047's third update put behind
   `addressBook:read`, and the gravest of ADR 0051's threats, because
   protected personal data exists for people whose safety depends on it.
8. **A plugin that steers whom the host serves.** If a class of caller were
   decided from the plugin's own records, its settings or the request, a
   plugin's mistake could serve anybody, and the board's consent would no
   longer say who uses the plugin.
9. **An outside party among the callers.** The property manager, and a person
   who rents a space without living here, are outside the house. What a
   resident route shows them of residents' records leaves the circle of
   neighbours that ADR 0051's threat 5 had in mind.

## Options

**(a) Leave the listed check and serve these people some other way**, for
example with a board route the plugin opens to `self:manage`. That is ADR
0051's option (a), without the narrowing, for exactly the callers the floor
does not trust.

**(b) A free predicate, or an allow-list that the plugin keeps.** The plugin
names the persons it serves, or a test the host runs over the plugin's records.
This is threat 8. A plugin-held list also answers "is this person listed?"
through what it accepts.

**(c) One flag, "every signed-in account".** It cannot leave out a former
resident while letting in a garage renter, nor let a board consent to the
board's own members and not to the property manager.

**(d) A closed list of classes of caller, declared in the manifest, consented
to with the install, and decided by the host from its own records.** Each class
names a record the core already keeps (a board seat, a system role) or one the
board writes in the core for the purpose (a plugin access). The three refusals
are tested before any class.

## Decision

Option (d).

### Declaring the callers

```jsonc
{
  "openbrf": {
    "id": "parking-share",
    "permissions": ["addressBook:read", "addressBook:readContact", "mail:send"],
    "residentRoutes": [
      { "path": "offers", "titleKey": "residentRoutes.offers" },
      { "path": "claims", "titleKey": "residentRoutes.claims" },
    ],
    "nonResidentCallers": [
      "board",
      "administrator",
      "propertyManager",
      "pluginAccess",
    ],
    "view": { "section": "building", "offeredTo": "signedIn" },
  },
}
```

`nonResidentCallers` lists who the plugin's resident routes serve besides the
people the address book lists to it. It is a closed list:

| Value             | The host serves a person who holds, on the day of the request                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `board`           | a board seat that has not ended (`BoardPosition`, `boardSeatHeldOn`), as the audience Styrelsen reads it |
| `administrator`   | the administrator system role (`SystemRole` `ADMIN`)                                                     |
| `propertyManager` | the property manager system role (`SystemRole` `PROPERTY_MANAGER`)                                       |
| `pluginAccess`    | a plugin access to this plugin, which the board grants on the person's page (see "Plugin access" below)  |

- At least one value, none twice, and only beside `residentRoutes`. The list
  holds for all of the plugin's resident routes. A plugin whose routes need
  different callers is a revisit trigger.
- A person who holds a residency today and is listed is served as a resident,
  whatever else they hold. The list adds people and narrows nobody.
- The core writes each value's text on the consent screen in Swedish and
  English. It is a closed list, so the curator writes nothing for it.

`view.offeredTo` has one value, `signedIn`, and is allowed only beside
`residentRoutes`. It offers the plugin's view to every account (see "The view
and the navigation").

A manifest that breaks one of these rules is `manifest-invalid`. The catalog
index refuses such an entry, and shares one rule function with the manifest,
as `residentRoutes` does.

The working name in the plan was `audience`. It is not used here, because
GLOSSARY.md gives _audience_ (målgrupp) to the feed, where it names who a post
is for and is derived by one check in the feed's own code.

### How the host decides who is served

The host decides from its own tables, read on the request, on the
association's calendar (`registers/held-on.ts`), as `PrincipalService` reads
roles. It never decides from the plugin's records, settings or answers, or
from anything in the request but the session's person. One predicate defines
"the persons this plugin serves", as `readableBy` now defines "the persons this
plugin may read":

```text
served(plugin, person) =
      readable(plugin, person)                -- the three refusals
  AND (   residency held today
       OR (    NOT former(person)             -- a former resident is in no class
           AND (   (board            declared AND board seat held today)
                OR (administrator    declared AND ADMIN role)
                OR (propertyManager  declared AND PROPERTY_MANAGER role)
                OR (pluginAccess     declared AND a plugin access to this plugin))))

former(person) =
      a residency that has ended (movedOutOn on or before today)
  AND no residency held today
```

A residency ends on its move-out date, which is the first day it is not held
(`residencyHeldOn` and `hasMovedOut` in `registers/held-on.ts`). So a person
whose move-out date is today is a former resident from the start of today, on
the association's calendar, and not from tomorrow. There is no day on which
they are neither a resident nor a former resident, and a board seat or a
system role they keep does not serve them for that day.

Here _declared_ means declared in the manifest and consented to with the
install (see "The consent screen"). A _former resident_ (tidigare boende) is
a person with a residency that has ended and none held today. The guard,
`caller`, the subject rule and `nonResidents()` all ask this one predicate, so
they cannot disagree about who is served. The navigation asks only its second
half, the residency or the class that a former resident is not in, for the
reason "The view and the navigation" gives.

The predicate is one function, and it builds `readable` and the second half
into one `where` of one query. Today "listed" is answered in more than one
place (`residents()`, `caller` through it, and `isListed`, which the guard and
the subject rule call). The core change puts all of them on this function, so a
residency check and a class
check can never run as two queries whose results the host combines.

A support session is in no class, whatever the administrator who opened it
holds. Nothing in such a session is the principal's own (ADR 0028), and the
guard already refuses it on every plugin route with `support-access-refused`,
before any of the checks below.

### The order of the refusals

`AuthorizationGuard` keeps the place and the order ADR 0051 gave it. It checks
in this order, and no code of the plugin's runs before it has finished:

1. **An account's own session.** A session is required, and a support session
   is refused, as it is today on every plugin route.
2. **The floor.** `self:manage`, and the handler's own `@RequireCapability`.
3. **The three refusals.** Protected personal data, a restriction, and a
   standing objection to this plugin's processing. They are the
   `readable(plugin, person)` half of the predicate, the same definition every
   register read uses. Any of the three refuses, whatever the person holds.
4. **Who is served.** A residency held today, or a class the plugin declares
   and the install consented to, and not a former resident.

Steps 3 and 4 are one predicate evaluated in one query, so which of them
refused does not change the path the host takes. Every refusal at step 3 or 4
is the same 403 with reason `resident-route-not-listed`, and the same wording.
The reason keeps its name, because plugins read it, although it now means "not
served". No class, seat, role or access lifts one of the three refusals: the
predicate is `readable AND (resident OR class)`, never
`(resident AND readable) OR class`.

**A former resident stays refused, whatever else they hold.** The board's
decision is that a former resident sees the page and does nothing, and that
holds for one who still has a board seat, the administrator or property
manager system role. No class lifts it, because a class is a reason to serve
somebody who has no residency, and the person who moved out has had one. The
predicate says so in one place, `NOT former(person)`, and the guard, `caller`,
the subject rule, `nonResidents()` and the navigation all ask it. A person who
has never held a residency, such as an external administrator, the property
manager or a garage renter, is not a former resident. A board member who
moved out and keeps the seat is one, and is refused until they hold a residency
again. That follows from the decision and not from this design. If the board
wants such a member served, it is a change to the decision and not an
exception to carry out here (see "Revisit triggers").

The refusal has one reason, and the plugin's view has one text for it. That
meets both of the board's asks at once. A former resident and a person who
objected read the same text, which says what the function is, that it is for
people connected to the house, and to ask the board if they think they should
have it. So the former resident is told what the page is for, and the refused
person gets no reason. A second
reason for "you no longer live here" would tell the plugin's own code, which
runs the view, that a caller who does not get it is withheld. ADR 0047 refuses
to tell a plugin why a person is not listed.

### Who is calling

`caller` gains a third answer:

```ts
type PluginAddressBookCaller =
  | { kind: "listed"; resident: PluginResident }
  | { kind: "nonResident"; person: PluginNonResident }
  | { kind: "notListed" };

interface PluginNonResident {
  personId: string;
  name: string;
  lastName: string;
  /** With addressBook:readContact; null under an objection to communications. */
  email?: string | null;
  phone?: string | null;
}
```

- `nonResident` is the answer for a person the plugin serves who holds no
  residency today. A plugin that declares no `nonResidentCallers` never gets
  it, so a plugin built before this record keeps the two answers it knows.
- It does not name the class. Whether the caller is a board member, the
  property manager or a garage renter is not something a plugin needs in order
  to offer or claim a space, and the less the plugin is told, the less it can
  show. A plugin that needs the class is a revisit trigger.
- It carries no apartment. The person has none in the register.
- Contact details follow the rules of `residents()`: present only with
  `addressBook:readContact`, and null under an objection to communications.

### Records about these people, and the space assignment

A person served under a class is named by their own person id. No subject of
another kind is made for them.

ADR 0047's subject rule becomes: the subject of a new record must be a person
**the plugin serves** (the predicate above) at the moment of the write. Before,
it was a person `residents()` would list. A record that already names a person
may be rewritten with the same subject after that person has moved out _or has
left the class_, for example when a term ended or the access was withdrawn. Any
other subject is refused with `PluginRecordSubjectError`, and nothing says why.
The same widening applies to the subject of an audit entry.

On a resident route the rule of ADR 0051 is unchanged, for every caller: a new
record names the caller, or the subject of the live record it replaces, which
the plugin can read. A garage renter's own offer and claim are records about
the caller. The board's assignment of a space to the garage renter is written
on a board route, where the widened rule accepts them. Reserving a space for
the poster of a wanted ad is still a job that is handed no person id, as giving
a cancelled claim's days back is.

Whether a subject is accepted off a resident route is still an answer, and
ADR 0047 put that answer behind `addressBook:read`. The widened rule stays
behind it. What the answer tells the plugin is no more than the two lists it
can read there, `residents()` and `nonResidents()`.

### `host.addressBook.nonResidents()`

```ts
nonResidents(): Promise<PluginNonResident[]>;
```

It returns the persons the plugin serves who hold no residency today, so that
no person is in both lists. These are the board members, administrators,
property managers and plugin-access holders of the classes the plugin declares
and the install consented to, and nobody the three refusals withhold. It needs
`addressBook:read`, as every member of `host.addressBook` does, and returns
contact details on the same terms as `residents()`. A plugin that declares no
`nonResidentCallers` gets an empty list, and so does a class the install did
not consent to.

This is a register read of people `residents()` never listed: the
administrator, the property manager, board members who live elsewhere and
plugin-access holders. With `addressBook:readContact` it includes their email
addresses and phone numbers, in a plugin that may also hold `mail:send`. So the
consent screen says so for each declared class (see "The consent screen"), and
does not leave it at "it also serves".

It is what lets the board assign a space to such a person on its board view,
and what lets a job find the address to mail them at. On a resident route it is
refused with `PluginResidentRouteError`, as `residents()`, `apartments()` and
`summary()` are. ADR 0051's table gains it beside them, and the hold reaches it
as it reaches every register read. `summary()` does not count these persons:
it counts the apartments and residents.

### Mail, the access report and erasure

These need no new mechanism, and the core change pins each one with a test.

- **Mail.** A job mails a person by the address `residents()` or
  `nonResidents()` gives it with `addressBook:readContact`. The rules of
  `host.mail` do not change. A disclosure (`recipients.fetch`) naming such a
  person is held to the rules it has today. Off a resident route that means
  neither protected nor restricted. On a resident route it means the caller or
  the subject of a readable record.
- **Access report.** `DataSubjectReport.pluginRecords` lists every record whose
  subject is the person, whether or not they live here, and it gains the
  person's plugin accesses.
- **Erasure and retention.** A granted erasure request names a person and not
  a residency, and `PLUGIN_RECORDS_PURGE` erases by subject. What keeps a
  person from being erased is written out today in five places:
  `DataSubjectRequestService.assertErasable` (which declines to record a
  grant), `purgeRefusal`, `computePersonPurgeDate`, the scheduled purge's scan
  in `purge.service.ts`, and `nothingRefusesErasure` in `withheld-persons.ts`.
  Each of them treats a residency, a board seat and a system role as reasons to
  keep the person. A standing plugin access has to be one in all five, or the
  scheduled purge would take a person whose only tie is an access once the
  retention period had passed. So the core change gives the five one shared
  definition of what keeps a person, and a plugin access counts in it with a
  reason code of its own. While an access stands, the grant of an erasure is
  declined, `computePersonPurgeDate` gives no date and the scheduled purge
  skips the person. The board withdraws the access first, which deletes its
  row, and the person's purge date is then computed as for anybody else. The
  purge never meets a person who still holds one.
- **Objection.** An objection to a plugin's processing is recorded on the
  person's page for any person in the address book, with or without a
  residency. So a garage renter can object, and is then refused at step 3.

### Plugin access

A **plugin access** (tilläggsåtkomst) is the board's grant to one person to be
served by one plugin's resident routes. It is the class for a person the core
has no other record for, such as somebody who rents a space and has never
lived here.

- The board grants and withdraws it on the person's page in the address book,
  under `addressBook:write`, for an installed plugin whose install consented to
  `pluginAccess`. The page shows which plugins the person has access to, and
  since when.
- The grant is made in the web interface only. `addressBook:write` stays in
  `DENIED_ACTION_CAPABILITIES`, so neither a connected app's token nor the AI
  package can reach it: a grant widens whom a plugin serves, and an assistant
  steered by a prompt could otherwise widen it past what the board decided.
  The action catalogue's denylist test covers the grant's route.
- It is held or not held, like a system role, and is not kept as history; the
  row carries the date it was granted. The grant and the withdrawal are written
  to the audit log with the person as the target, the plugin's id and the
  audit channel, and with no reason or free text.
- It grants no capability, no audience in the feed and no place in a group.
  `residents()` does not list the person, and `nonResidents()` does. It counts
  only towards being served by that plugin and being offered its view.
- It is a new store of personal data. It appears on the person's access report
  and goes when the plugin is removed. While it stands, the person is kept, as
  for a system role, in all five places that decide it (see "Mail, the access
  report and erasure"). A withdrawal takes effect on the person's next request.
- It is for a person who has never lived here, and only then. The grant is
  refused for a person with any residency on record: one held today, one
  recorded to begin later, or one that has ended, because a former resident is
  not served in any class (see "The order of the refusals"). When a residency
  is recorded for a person who holds an access, whether it begins today, later
  or has already ended, the same write ends their plugin accesses, with an
  audit entry for each, and the form says so before it is saved. So no access
  outlives a person's first residency, and nobody holds one who is a former
  resident.
- A person with no residency is kept while an access stands, with no retention
  period running. (A person who holds one has never had a residency.) So the person's page shows how long each access has stood,
  and the address book lists the persons whose only tie to the association is
  a plugin access, for the board to review.

### Getting an account

A person who does not live here gets an account the way a board member who
lives elsewhere gets one today. The board adds them to the address book
without a residency, grants the plugin access, and sends the invitation from
the person's page. Only the plugin access is new.

The account request stays for people who live here. The form is public and
anonymous, and what it asks for is checked against a residency the board
records at approval. "I rent a garage" is a claim the form cannot check and the
board has no residency to record for, so a form open to it would be open
registration under another name. A person who rents a space has an agreement
with the association, and so the board has their name and address already.
Associations that have many such people and ask for a form are a revisit
trigger.

### A name shown at its subject's own choice

A record may let its subject have their name, and a resident their apartment,
shown to the others whom the route serves, as a named wanted ad, reply or
reservation does. ADR 0047 says a name is "read again when needed, not
stored". A resident route cannot read the register, so the plugin could only
keep a copy. A copy cannot be recalled: the plugin's code would have to notice
that the subject moved out, lost their last class or was withdrawn, and the
host cannot see the value to check that it does. ADR 0047 itself keeps a moved
out person's records readable until `eraseOn`, and the address book's
withholding looks at protection, restriction and objection and never at
residency. So an unexpired named record would show a name and an apartment
long after its subject stopped being served, and that would break the cutoff
this record promises. So the host does the reading, on every read, and the
plugin never holds the value.

- **A flag on the record.** A write to `host.personRecords.put` may set
  `showSubject: true` beside `subject`, `eraseOn` and `value`. The host keeps
  it as a column of its own, false by default, and the access report prints it
  with the record. It is the subject's tick, and the host, not the plugin,
  holds that it is the subject's:
  - **Only the subject's own session writes it.** A write sets or withdraws the
    flag only when the request's authenticated session is the record's subject
    after the write, on a resident route or a board route alike. In that case
    the flag is the one the write sends, and a write that omits it withdraws
    it. A job, a support session (ADR 0028) and a session of any other person
    never set it and never withdraw it: whatever `showSubject` such a write
    sends is ignored.
  - **Every other rewrite keeps what the subject chose.** A rewrite by anybody
    else that keeps the record's subject leaves the stored flag as it was. A
    write that gives a live record another subject, which only a board route
    can do for a person other than the caller, stores the flag as false, since
    the new subject has not chosen. A new record written by anybody but its
    subject stores it as false.
  - **Neither the subject rule nor the rewrite exemption lets one person's
    record be shown by another.** The exemption that lets a rewrite keep the
    subject of a live record the plugin can read (see "Records about these
    people") lets the plugin keep a record. It does not let it choose what the
    record shows.
- **Only a collection that declares it.** The collection's declaration gains
  `showsSubject: true`. A write that sets the flag on a collection without it
  is refused. The consent screen names each collection that declares it ("may
  show a person's name, and a resident's apartment, to those the plugin serves,
  when that person chooses"), and a republished version that adds the
  declaration is refused at load as `personal-data-widened`. An instance that
  predates this record reads a collection strictly, so it refuses a manifest
  that declares `showsSubject`, and the index version it reads cannot list
  one; it ignores the flag on a write. Either way the plugin shows nobody's
  name there, and fails closed.
- **A field on the read.** `personRecords.get` and `list` return, on a record
  whose flag is set, `shown: { name: string; apartment: PluginApartment | null }`
  when the record's subject is served by the plugin on that request, and no
  `shown` otherwise. `name` is the subject's name as `residents()` gives it;
  `apartment` is their apartment if they hold a residency today and `null` if
  they are served in a class. It is never a contact detail, never the last name
  alone and never anybody but the record's subject. It is on a resident route
  as everywhere. The host reads it from the register on the read itself, with
  the predicate of "How the host decides who is served", and reads the record,
  the persons the plugin may not read, the classes the install serves and the
  subject's name from one consistent snapshot of the database, so that the
  answer is the register as of one moment: the record and its `shown` are
  either both before a change or both after it. That is a `REPEATABLE READ`
  transaction, not one statement, since the record's subject is a plain column
  and the reads cannot be joined, and a `READ COMMITTED` read is not enough,
  since a withdrawal or a move-out committed between its reads would leave the
  name resolved for a record that no longer says what it was read as. The
  snapshot takes nothing away from the rest: each read keeps its own cutoff,
  a withheld subject's record is still not returned, and no name is cached or
  stored. Nothing of it is stored in the record.
- **So the cutoff is the host's.** A subject who moves out, whose board seat
  ends, whose system role is removed, whose plugin access is withdrawn, or for
  whom the install's consent to the class is withdrawn, is not served on the
  next read once that was the last thing that served them, and the next read
  then carries no `shown`: living here, or another class the plugin still
  serves, keeps them served and keeps the name shown. A subject who has become
  a former resident is not served, and the next read carries no `shown`. Nothing waits on a job, an expiry date or the plugin. A subject who
  becomes protected, restricted or objecting is absent from the read as a
  whole, as ADR 0047 already has it. A record that is past its `eraseOn` is
  absent as before. The plugin's own cutoff by the record's dates, such as the
  last day of an ad, stays the plugin's feature, and the host does not enforce
  it.
- **No new oracle.** `shown` absent on a record whose flag is set tells the
  plugin only that its subject is not served now and is not withheld, because a
  withheld subject's record is not returned at all. That is the bit ADR 0047
  already accepts, "a person who moves out and a person who becomes protected
  … both leave `residents()`", and still the plugin learns it only about a
  person it keeps a record about, never the reason, and never which class. A
  resident route can keep a record about a third person only by rewriting one
  it can already read, with the same subject. That rewrite cannot raise the
  flag, because only the subject's own session can, so the plugin cannot use
  `shown` to ask whether a third person is served. It learns it only for a
  person who chose to be shown. The plugin has to show the record the same way
  whether the flag is unset or `shown` is absent. Then nobody who reads the
  route's answer can tell a subject who did not tick from one who is no longer
  served. Catalog review reads that, as it reads the rest of what a route shows.
- **What it does not cover.** Free text can name anybody, and the host cannot
  read it. A plugin that copies `shown` into a value or a response it keeps
  defeats the cutoff, and the host cannot see that either. The rule that it
  does not is read in catalog review, and the consent screen says so. The host
  refuses a write that holds another person's id, as ADR 0047 has it, but it
  does not look for a name in a value, since a name is not an identifier, and a
  guess would refuse a plain word and let a spelling through.

This replaces what the plan first had, a name and an apartment that the plugin
took from `caller` and stored in the record. That copy is exactly what the host
has no way to recall.

### The data subjects

No new manifest value. The host adds the categories from the classes, as it
adds former residents for a plugin that keeps records about a person (ADR
0035, "Former residents", proposed alongside this record). `board` adds the
record of processing's existing `boardMember` category. `administrator`,
`propertyManager` and `pluginAccess` add its existing `external` category,
"somebody outside the association entirely: a contractor, a broker, an external
property manager". The consent screen, `openbrf plugin add` and the seeded row
in the record of processing activities name them after the declared
categories, from the same function.

A required manifest value would be a new value in a strict enum. An instance
released before it refuses the manifest, and refuses the whole catalog index if
any entry uses the value. The fact follows from `nonResidentCallers`, which the
host reads anyway.

### The view and the navigation

ADR 0051 offered such a plugin's view to an account that holds a residency
today, and to nobody else. It is now offered to that account and to an account
in a class the plugin declares and the install consented to, unless it is a
former resident's. A board member or administrator who lives elsewhere is
offered it when the plugin declares their class. The navigation asks the second
half of the predicate and not the first: it does not read the three refusals,
for ADR 0051's reason: the navigation is not where access is decided, and a
refused resident is already offered the entry and told by the view. It does
read `former`, so that the entry and the routes agree on a former resident,
who with `offeredTo: "signedIn"` sees the page all the same.

With `offeredTo: "signedIn"` the view is offered to every account that holds
`self:manage`, which is every account. That is how a former resident sees the
page. Its routes still refuse whoever is not served, and the view says what the
function is. It is never offered in the board's section, which the manifest
already refuses beside resident routes. The offer is not consented to and is
not in the catalog index. The board consents to what a plugin may do and read,
and a page is neither (ADR 0051, "Update, 2026-10-26").

### The consent screen

The consent screen and `openbrf plugin add` show the declared classes after the
resident routes, in the association's language, naming each declared class
and only those. In English, with every class declared and
`addressBook:readContact` held:

> **It also serves people who do not live here**, on the same routes and held
> to the same rules: board members who do not live in the house; the
> administrator; the property manager, an external party; and people the board
> gives access to this plugin on their page in the address book. A person with
> protected personal data, under a restriction, or who objected to this
> plugin's processing is refused there, as a resident is.
>
> **The plugin can read who these people are.** Outside the routes residents
> call, it can read their names, and their email addresses and phone numbers.
>
> **They see what residents show.** What the plugin shows them of residents'
> records is its choice; its description says what that is, and the plugin
> tells a resident before they offer or post that these people will see it.
> A name and an apartment shown at a person's own choice come from the
> register on each read, so they stop when the person is no longer served.
> The host cannot see what else a record holds, free text included, so it
> cannot check that.
>
> **The property manager is an external party.** The association's processor
> agreement with them has to bind their staff to confidentiality and to the
> association's purpose for what they see here, whether they use the plugin in
> their work for the association or for their own. The agreement must also
> cover their work in Open BRF: SBC's template, for example, ties processing to
> the platform SBC itself uses. Their system role is per
> account: end it when a member of their staff leaves.

Without `addressBook:readContact` the second paragraph says names only. Each
paragraph names only the declared classes, and the last appears only when
`propertyManager` is declared.

Plugins are installed by the administrator (`association:manage`), not by the
board: a board seat does not grant it. So it is the administrator who consents
to the classes, and the board's decision to admit them is a precondition the
core cannot check. In a small association the administrator's account may be
the property manager's own, and then the property manager consents to their own
class. So the consent to each class is written to the audit log with the
account that gave it, and the board reads on the plugin's page which classes
the install serves and who consented to them. Where this record says "the board
consented", it means this consent, given on the board's decision.

The install records two sets of classes beside the consented resident routes,
and the host serves a third that it derives from them. The _approved_ set holds
every class the administrator has consented to for this plugin. The _withdrawn_
set holds the approved classes the administrator has switched off since, and is
always a subset of the approved set. The classes a plugin _serves_ are the
declared ones that are approved and not withdrawn, worked out on each request
and never stored, so the manifest never has to change for a class to stop being
served. An install with nothing recorded has approved no class, so the host
serves no class for it, and a release that carries the guard's new predicate
but not the recorded consent serves no one new.

On load:

- **A declared class outside the approved set is a widening.** The version is
  refused as `resident-routes-widened` until the administrator consents again,
  and consenting adds the class to the approved set. A withdrawn class is
  approved, so it is no widening: the same version loads again after a restart
  and the class stays withdrawn.
- **A version that drops a class** loads, because it serves fewer people. Both
  sets are then cut down to the classes the version declares, so a class it
  dropped is neither approved nor withdrawn any more, and a later version that
  adds it back is a widening. A class the version still declares keeps its
  state, withdrawn or not.
- **Nothing on load adds to the approved set, and nothing on load takes a
  class the version still declares out of the withdrawn set.** Only the
  administrator's consent does, on the consent screen or on the plugin's page.
  Dropping a class is the one thing a load does to the withdrawn set, as the
  item above has it.

The administrator can withdraw one class on the plugin's page without removing
the plugin, which adds it to the withdrawn set, and the class stops granting
access from the next request on. A person is still served while another
approved class they belong to, or a residency held today, grants access.
Consenting again to a withdrawn class takes
it out of the withdrawn set and serves it from the next request. Both acts, and
the consent to a class added by a version, are written to the audit log with
the account that gave them.

### What catalog review reads

Besides what ADR 0051 asks of every resident route:

- **Who it serves, and what each of them sees.** The description names every
  class it declares and what a caller in each sees of other people's records.
  The rule on what a route returns about anybody but the caller holds for
  every caller it serves, and the property manager and a plugin-access holder
  are outside the house.
- **What the screen tells a resident.** ADR 0051 asks the screen before a
  resident offers or posts to say what neighbours will see. With a class
  declared, it names every class the plugin serves, from the same text the
  consent screen uses, and not only neighbours. A space label with dates is
  also a signal of when a home is empty, and a stranger who knows the courtyard
  can read it as one. So a route shows a caller outside the house only as much
  of an offer's dates as the feature needs: a claim needs the span it claims,
  and not every offer of the house with its label and holder.
- **A name shown at its subject's own choice.** The host resolves it, the
  plugin never stores it. See "A name shown at its subject's own choice"
  below. Catalog review reads that the plugin sets `showSubject` only from a
  tick that is off by default, whose label says who will see the name (the
  property manager included when that class is declared), and that it never
  copies the `shown` it is given into a record's value, a setting, a cache or
  memory, or a response to a later request. It renders a ticked record whose
  `shown` is absent exactly as it renders an unticked one. The host cannot see
  free text, so it cannot check any of this, and the consent screen says so.
- **What reaches it from elsewhere.** ADR 0051's bullet becomes: no register
  data read in a job, a board route or a settings screen reaches a resident
  route's answer through memory, `host.records` or a person record's value,
  and no register read is kept in memory to be served across routes. What
  `nonResidents()` returns is register data in this sense, read off the route,
  and is held to the same rule. So is the `shown` of a record: it is given
  for the response it is read for and kept nowhere.
- **Free text.** A free-text field says in its hint who will read what is
  written there, and the plugin shows the text to nobody else. The board's
  moderation is the plugin's own (wanted ads have it).
- **A class it does not need.** A plugin that declares `propertyManager` or
  `administrator` names in its description what those people do with it. A
  class the features have no use for is not listed, as a collection of records
  about a person its features have no use for is not (ADR 0047).

### What nobody learns

Taken one by one, the new answers stay within ADR 0051's bound. Each tells the
caller about themselves, or tells the plugin something behind
`addressBook:read`. One of them, `nonResidents()`, is new data for the plugin
and not a new view of what it read before, which is why the consent screen
names it.

| Answer                                       | Who learns it                   | What it says                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The guard's refusal                          | The caller                      | That the caller is not served, about the caller alone, with one reason for all six cases.                                                                                                |
| `caller` (`nonResident`)                     | The plugin                      | Who the caller is: the caller alone, and only for a plugin that declares a class.                                                                                                        |
| The navigation entry                         | The caller                      | About the caller alone, and not whether they are withheld: a withheld person in a class is offered it as well.                                                                           |
| `nonResidents()`                             | The plugin, off resident routes | Names, and contact details, of people `residents()` never listed, in the consented classes only, with the three refusals applied. Consented to by name. Refused on a resident route.     |
| A subject that is accepted                   | The plugin                      | Off a resident route, what the two lists say. On a resident route, unchanged: the caller or a readable record.                                                                           |
| A plugin access                              | The board                       | Granted on the person's page, which the board reads already.                                                                                                                             |
| `shown` on a record the subject ticked       | The plugin                      | The name, and for a resident the apartment, of the subject of a record it already reads, while that subject is served. Absent otherwise, which says only "not served now, not withheld". |
| A record that leaves a resident route's list | The caller                      | As for a resident (ADR 0051, threat 4): the route shows it the same way whatever the reason.                                                                                             |

No caller on a resident route can introduce a subject other than themselves.
The subject rules there have not changed: a new record names the caller, and
the one other subject accepted is that of the live record being rewritten,
which the plugin can already read and which is accepted whether or not that
subject is still served. `nonResidents()` is refused there, so a property
manager or a garage renter cannot ask, through the plugin, whether anybody else
is listed or served.

### The property manager

**Verdict: stands, with conditions.**

What the property manager gets is narrower than "the address book". They gain
no capability: `PROPERTY_MANAGER_CAPABILITIES` stays `issues:handle` and
`self:manage`. On a resident route the host refuses `residents()`,
`apartments()`, `summary()` and `nonResidents()` to the plugin for every
caller, and `caller` answers the property manager about the property manager
alone. So no route of any plugin hands them the register. What they see is what
other people chose to put in front of everybody the plugin serves. For parking
share that is:

- an offer's space label and days, unnamed unless the holder ticked it; to
  somebody who knows the courtyard a label can point to an apartment (ADR 0051,
  threat 5);
- a wanted ad's days and note, with the poster's name and apartment only when
  the poster ticked it and for as long as the poster is served;
- a reply to an ad they posted themselves, with the holder's name only when the
  holder ticked it and for as long as the holder is served;
- their own offers, claims and ads.

That is personal data of residents reaching an external party. The glossary
row's promise, "never the address book", still holds. Its "issue handling
only" no longer does, and the row changes to say so. It stands on these
conditions:

1. **The host never widens them.** The property manager's capabilities stay as
   they are. They are served only by a plugin that declares `propertyManager`,
   on its resident routes, after consent to that class on a screen that names
   them as an external party, given by the administrator on the board's
   decision and written to the audit log with the account that gave it (see
   "The consent screen"). The three refusals hold for them, and every register
   read is refused on the route. The core change carries a test for each.
2. **What lets residents' data reach them, and what binds them.** The classes
   exist so that the property manager can act in the plugin: offer, claim,
   post and reply. That can be their work for the association, or their own or
   their firm's use as a participant. In the second case what they see is a
   disclosure to a recipient, and a processor agreement does not give it a
   lawful basis. So the basis is not the agreement. It is the resident's own
   act on a screen that tells them the property manager will see it (see "What
   the screen tells a resident"), and for a name or an apartment the tick
   beside it. What the agreement does is bind the property manager's staff:
   the association's processor agreement with them (GDPR art. 28(3)(a) and
   (b)) must contain confidentiality and purpose limitation that cover what
   their staff see here, whichever way they use the plugin. The core cannot
   check an agreement, and the consent screen says so. The property manager's
   system role is held per account, so a member of their staff who leaves has
   their role ended, and the consent screen says that too.
3. **The record of processing names them.** For parking share,
   `docs/parking-share-data-protection.md` names the property manager among the
   recipients (art. 30(1)(d)), says what they see as listed above, and the
   privacy notice follows (art. 13(1)(e)).
4. **A name is never shown to them by default.** Each tick that shows a
   person's name or apartment is off by default, as the board decided, and its
   label says that the property manager is among those who will see it.
5. **The glossary row changes** (below), in the same change as this record.

None of these needs a new decision from the board. The board took the decision
to include the property manager knowing this, and the conditions are what it
takes to carry that decision out. What the board is told changes in one
respect: a ticked name and apartment is register data a plugin passes on, so
the glossary row no longer says "nothing of it through a plugin". It says the
property manager sees only what a resident chose to show.

### The glossary

- **property manager** (förvaltare / vicevärd): "External role with access to
  issue handling, and never to the address book: no capability of the
  register's, and no register read through a plugin. A plugin that declares
  the property manager among the callers its resident routes serve, and whose
  install consented to that class, serves them there as well (ADR 0053). There
  the host still refuses the plugin the register, so they see only what a
  resident chose to show, and the association's processor agreement with them
  binds their staff to confidentiality and purpose for it."
- **resident route** (boendeväg): it answers a person the address book lists to
  the plugin, _and a person in a class of caller the manifest declares and the
  install consented to: a board seat held on the day, the administrator or
  property manager system role, or a plugin access. A former resident is in no
  class_. The three refusals are tested first.
- **plugin access** (tilläggsåtkomst), new: the board's grant to one person who
  has never lived here to be served by one plugin's resident routes. Refused for
  a person with any residency on record, current, ended or yet to begin, and
  ended when one is recorded.
- _Account request_ and _audience_ do not change.

### The contract, the SDK and the order of release

The change is additive to contract version 1, and `apiVersion` stays `1`.

- **`@openbrf/plugin-sdk`**, a minor release: `nonResidentCallers` and
  `view.offeredTo` in the manifest schema, with one rule function that the
  manifest and the catalog index share; `PLUGIN_NON_RESIDENT_CALLERS`;
  `PluginNonResident`; the `nonResident` kind of `PluginAddressBookCaller`;
  `PluginAddressBook.nonResidents`; `showsSubject` in the collection
  declaration, `showSubject` on the record a plugin writes and `shown` on the
  record it reads; and the derived data subjects, in the one
  function that the consent screen, the CLI and the seeded row share for former
  residents.
- **The catalog index** carries `nonResidentCallers` on a plugin entry, because
  the consent screen shows it before the download. It is a new field, so it is
  index version 4 (`catalog-v4.json`), and the core's curated address moves to
  it. A catalog keeps serving version 3, without the entries that use the
  field, to older instances. Those entries are the only ones whose processing
  this record changes, so an older instance never sees them.
- **The core:** the predicate, with `former`, and with it the guard, `caller`,
  the subject rule, `nonResidents()`, the navigation, and `nonResidents()` in
  the resident-route table and the hold. The `showSubject` column and the
  resolution of `shown` in the query that reads a record, the consent screen's
  text for a collection that declares `showsSubject`, and the access report's
  print of the flag. Plugin access: its table and migration,
  the person's page and the address book's list of persons whose only tie is
  an access, the audit entries, the access report, its end when a residency is
  recorded, and the one definition of what keeps a person that the five
  erasure and retention places share. The consent screen and `openbrf plugin
add`, with their text in Swedish and English. The approved and the withdrawn
  classes recorded with the install, both cut down to the declared set when a
  version loads, the consent to each class in the audit log, withdrawing and
  consenting again to one class on the plugin's page, and
  `resident-routes-widened` for a class declared outside the approved set. Reading
  version 4 of the index.
- **`docs/plugin-contract.md`**, written with the core change: "Resident
  routes", "Who is calling", "Records about a person" (with the flag and
  `shown`), "Where a view is found" and the catalog index.
- **Regressions the core change carries**, each through the real router, and
  each failing when the guard it tests is removed:
  - For a resident and for a person in each class, each of the three refusals
    answers 403 `resident-route-not-listed` and runs no code of the plugin's.
    With every class declared, the status and body are byte for byte the same
    for a protected person, a restricted one, an objecting one, a former
    resident, a former resident who holds a class, a person in no class, and a
    person in a class who is withheld.
  - A former resident is refused with every class declared, also one who
    holds a board seat that has not ended, the administrator role or the
    property manager role, and gets the same answer from `caller`
    (`notListed`), `nonResidents()` (absent) and the subject rule. This holds
    on the move-out date itself: with today as `movedOutOn`, a person who keeps
    a board seat or a system role is refused at once, and the same request on
    the day before is served as a resident. The test fixes the
    clock on the association's calendar and checks both days for the guard,
    `caller`, `nonResidents()`, the subject rule, the navigation and `shown`.
    A person whose residency begins tomorrow, who has had none and holds no
    class the plugin declares and the install consented to, is refused. One
    with the same residency who also holds such a class is served in it, as
    somebody with no residency yet is not a former resident. One who holds an
    ended board seat is refused. One who has never had a residency and holds a
    plugin access is served. A former resident who regains a residency today
    is served as a resident.
  - The grant of a plugin access is refused for a person with a residency that
    has ended, as for one held today or recorded to begin.
  - A person in a class the plugin does not declare is refused, and so is one
    in a declared class the install did not consent to. A support session is
    refused whatever the administrator behind it holds.
  - A withdrawn plugin access, an ended term and a removed system role each
    refuse the person's next request.
  - On a resident route served to the property manager, `residents()`,
    `apartments()`, `summary()` and `nonResidents()` raise
    `PluginResidentRouteError`. A new record naming anybody but the caller,
    and a rewrite that changes the subject of a live record to anybody but the
    caller, are refused with `PluginRecordSubjectError`. A rewrite that
    changes the subject to the caller succeeds, as ADR 0051 has it, and so
    does one that keeps the subject of a live record the plugin can read, also
    when that subject is not served now and is not the caller.
  - On a board route, a record about a person in a declared class is accepted.
    One about a person in no class, a protected person and an unknown id are
    each refused with the same `PluginRecordSubjectError`.
  - `caller` answers `nonResident` only to a plugin that declares the person's
    class, and `notListed` otherwise. A person with a residency today and a
    class is answered `listed`, never `nonResident`, and is in `residents()`
    only.
  - `nonResidents()` leaves out every withheld person and every person with a
    residency today. A plugin that declares only `pluginAccess` gets only
    access holders from it, and a class that is undeclared, not consented to
    or withdrawn gives nobody.
  - The navigation offers the view to a person in a declared class and not to
    one in an undeclared class or to a former resident in a declared one, and
    does not read the three refusals. With
    `offeredTo: "signedIn"` it offers the view to every account, and never in
    the board's section.
  - **Only the subject chooses to be shown.** In a collection that declares
    `showsSubject`, with resident A, resident B and a job, through the real
    router, resident routes included. A lists B's record, which B has not
    ticked, and rewrites it with B as the subject and `showSubject: true`: the
    write succeeds as a rewrite, the stored flag stays false, and no read by A
    or by anybody else carries `shown` for it, so A learns nothing of B's
    register name, apartment or served status. B's own request sets the flag
    and a read by A then carries `shown`; A's rewrite of that record with
    `showSubject: false` or with the field omitted leaves it set; B's own
    request withdraws it, and an omitted field on B's own rewrite does too. A
    write that gives B's record to the caller A, or a board route's write that
    gives it to a third person, stores the flag false. A job that writes B's
    record with `showSubject: true` leaves it false, and so does a support
    session. Each of these fails when the check of who the session is, is
    removed.
  - **A name does not outlive its subject's being served.** In a collection
    that declares `showsSubject`, a resident posts a record with the flag set,
    and another served caller reads it through the real router, resident route
    included, and gets `shown` with the name and the apartment. Then, in
    turn, the subject, with nothing else serving them, moves out; holds a class
    and its board seat ends; has the system role removed; has a plugin access
    withdrawn; has the install's consent to the class withdrawn; or is a former
    resident whose board seat has not ended. After each, the same caller
    reads the record, which has not reached its `eraseOn`, and neither the
    response nor any field of it carries the name, the apartment or any part of
    them, while the rest of the record is returned as before. The test plugin
    stores no name in the value, and the case fails if the host reads `shown`
    from anything but the register on that request. A subject whose plugin
    access is withdrawn while a board seat or another served class still gives
    them access keeps the name shown. A subject who becomes
    protected, restricted or objecting is absent from the read as a whole. A
    write that sets the flag in a collection without `showsSubject` is
    refused. In a collection that declares it, the subject's own rewrite
    without the flag withdraws it, so the next read returns no `shown`, while
    another caller's rewrite without the flag keeps the stored flag, so the
    next read of a served subject whose flag is true still returns `shown`.
  - A plugin access appears on the person's access report. An erasure grant is
    declined while it stands and recorded once it is withdrawn. A record about
    a plugin-access holder is on their report and goes with that erasure.
  - For a person whose only tie is a plugin access, `assertErasable`,
    `purgeRefusal`, `computePersonPurgeDate`, the scheduled purge's scan and
    `nothingRefusesErasure` agree that the person is kept. Once the access is
    withdrawn, the person gets a purge date as anybody else does, and the
    scheduled purge takes them after it.
  - Recording a residency for a person who holds an access, one that has
    already ended included, ends the person's accesses, with an audit entry
    for each.
  - The grant's route is absent from the action catalogue and refused to a
    connected app's token and to the AI package.
  - **Withdrawal survives a reload.** An install declares the board and the
    property manager, and the administrator withdraws the property manager.
    Its members are refused on their next request and the plugin stays
    installed. After a restart on the same version the plugin loads, and
    still serves the board and not the property manager: it is neither refused
    as `resident-routes-widened` nor served the withdrawn class again.
  - A version that drops the board while the property manager stays withdrawn
    loads and serves nobody in either class. The property manager is still
    withdrawn after it, and a later version that adds the board back is
    refused as `resident-routes-widened`.
  - A version that adds a class is refused until the administrator consents.
    After consent the class is served. Consenting again to a withdrawn class
    serves it from the next request without a new version, and a restart then
    keeps it served.
  - The consent to a class, its withdrawal and a second consent are each in
    the audit log with the account that gave them.

An instance that predates this record ignores `nonResidentCallers` and
`offeredTo`, because the manifest is not read strictly. It serves only the
listed residents and offers the view only to residents, so the plugin fails
closed. A plugin detects `nonResidents` before calling it, as for any member
added after version 1.

The order is the same as ADR 0051's: the SDK and the core in one release, then
the catalog index's version 4, then parking share declaring its callers against
that SDK, and then its new catalog entry.

## Consequences

- Parking share can serve the people the board named, and leave out former
  residents, whatever they still hold, and the three refused groups, through
  one declaration that a catalog reviewer and the board can read.
- The property manager can see what residents choose to show in a plugin that
  declares them. The glossary says so, and the association's processor
  agreement and record of processing have to cover it.
- "Is this person listed?" stays behind `addressBook:read`. A caller on a
  resident route cannot ask it about a person other than themselves: the
  subject of a record they rewrite is accepted whether or not it is served.
- The core keeps a new kind of record, the plugin access, with its own place on
  the person's page, in the access report and in erasure and retention. It
  ends when its holder gets a residency, and a person who has had one cannot
  be granted another, so a garage renter who becomes a resident and moves out
  is a former resident and is not served.
- The board does not consent to a plugin itself: the administrator does, on
  the board's decision, and the audit log says who.
- A resident route's guard runs one predicate where it ran `isListed`, still one
  query before the handler. Every place that answered "listed" moves to it.
- A plugin built against the new SDK has three `caller` answers to handle, and
  the third arrives only when it declares a class.
- The account request stays narrow. A person who does not live here depends on
  the board to add and invite them.

## Rejected alternatives

- **A space-holder class decided from the plugin's records.** It is what the
  plan first named. The host would serve whoever the plugin had written an
  assignment for, so the plugin would decide whom the host serves (threat 8).
  The assignment itself needs the widened subject rule first, so the class
  would rest on itself. A plugin access is the same person, decided by the
  board in the core.
- **A system role for "connected to the house".** It would serve the person in
  every plugin that declared the class, so the board could not admit a garage
  renter to parking share alone. And a system role is the administrator's to
  grant, while who uses a parking space is the board's affair.
- **Opening the account request to people who do not live here.** See "Getting
  an account".
- **A second refusal reason for a former resident.** It would tell the plugin's
  view that a caller without that reason is withheld (see "The order of the
  refusals").
- **Telling the plugin the caller's class.** Nothing in the features needs it.
- **A new `dataSubjects` value that the manifest must declare.** See "The data
  subjects".
- **Giving the property manager register reads on a resident route**, such as
  `residents()` for a picker. That breaks the half of the glossary row that
  stands.
- **Naming the field `audience`.** The glossary gives that term to the feed.

## Revisit triggers

- **A plugin's resident routes need different callers from one another.** The
  list would then be declared per route.
- **A plugin needs to know which class a caller is in.**
- **The board wants a former resident served** because they keep a board
  seat, a system role or rent a space. That changes the decision that a former
  resident does nothing, and the predicate's `NOT former(person)` with it.
- **An association with many outside space holders asks for an account
  request form** for people who do not live here.
- **A second plugin declares `propertyManager`**, or the property manager
  needs a plugin's board view. Each widens what the glossary row allows.
- **Catalog review finds a plugin showing a name its subject did not choose to
  show** to a caller who does not live here.
