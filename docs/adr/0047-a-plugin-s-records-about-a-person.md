# ADR 0047: A plugin's records about a person

Date: 2026-10-19

## Status

Accepted. Builds on [ADR 0033](0033-a-plugin-s-own-records.md), whose store
stays free of personal data, and on
[ADR 0035](0035-a-plugin-s-processing-and-objecting-to-it.md), whose
`processing` declaration and `host.audit` it extends. Answers ADR 0033's
revisit trigger "a plugin needs to keep personal data".

Amends ADR 0033's storage in two places: `PluginRecord` is no longer unique on
plugin, collection and key alone, and no longer cascades from the installed
plugin. See "Where the records live" and "Removing a plugin".

Updated 2026-10-24, four times: the limits count live rows only, and a record
leaves the plugin's view on its erase date, so neither can reveal a hold; what a
plugin's records do reveal about a person is stated, with the address-book
permission it takes; and a record may name no person but its subject, and what
a hold keeps of one record is bounded to a version a day. The sections below state the rules as they now
stand, and the updates at the end give the reasons.

## Context

ADR 0033 gave a plugin a keyed store and forbade personal data in it. The reason
was the rest of the platform rather than the store: the data subject access
report, the purges, erasure, restriction and the record of processing
activities all read the core's own tables, every column that names a person is
answered for by name (ADR 0019), and a plugin's JSON is opaque to all of them.
Its revisit trigger said what would change that: a plugin that needs to keep
personal data.

The paid modules do. Parking share keeps who offered a space for which days and
who claimed it. A booking module beyond the core's keeps who booked what. Each is
an operational record about one person, of the kind the core keeps for its own
bookings and event sign-ups, and each needs what the core gives those: a
retention window that runs out by itself, erasure on a granted request, a
legal hold and a restriction that stop both, a section in the access report, an
audit entry that reaches the person it is about, and the identity of the person
making the request. A plugin has none of these today.

- Its only state is its settings, one JSON object on the installed plugin's row,
  and ADR 0033's store.
- It cannot bring a table: the runtime database role creates nothing
  (`harden-runtime-role.sql`), and a downloaded package changing the schema the
  statutory registers live in was rejected in ADR 0033.
- It cannot inject the database, the audit log or the field encryption
  (`DENIED_INJECTIONS`).
- It cannot tell who is calling. `host.actions` reads the caller from a mark on
  the request and gives the plugin no way to read it.
- Nothing calls a plugin when a purge runs or an access report is built, and the
  access report's sections are a closed interface.

Two other modules show what is not needed. Digital signage keeps configuration
and no people (ADR 0033), and the broker package keeps nothing at all, because
its record of what was sent is the audit log's. Neither is a reason to make this
smaller; both are a reason not to make it larger.

## Decision

### Records about a person are a separate member, declared per collection

The host object gains `host.personRecords`. It has the same shape as
`host.records`, holds records under a collection and a key, and is held to the
same limits, which it shares with `host.records`: 10 000 records and 16 MiB per
plugin, 64 KiB per value. Each record names one person and carries the day it
is erased.

```ts
export interface PluginPersonRecords {
  get<Value extends JsonObject>(
    collection: string,
    key: string,
  ): Promise<PluginPersonRecord<Value> | null>;

  /** In key order. At most 200 per call. */
  list<Value extends JsonObject>(
    collection: string,
    options?: { subject?: string; after?: string; limit?: number },
  ): Promise<readonly PluginPersonRecord<Value>[]>;

  put<Value extends JsonObject>(
    collection: string,
    key: string,
    record: { subject: string; eraseOn: string; value: Value },
    options?: { expectedRevision?: number | null },
  ): Promise<PluginPersonRecord<Value>>;

  delete(
    collection: string,
    key: string,
    options?: { expectedRevision?: number },
  ): Promise<boolean>;
}

export interface PluginPersonRecord<Value extends JsonObject> {
  readonly collection: string;
  readonly key: string;
  /** The person the record is about, as `host.addressBook` names them. */
  readonly subject: string;
  /** The association's calendar day (ADR 0013) the host erases it on. */
  readonly eraseOn: string;
  readonly value: Value;
  readonly revision: number;
  readonly updatedAt: string;
}
```

A value is a JSON object, so that the access report can label its keys.

A collection that holds records about a person is declared in the manifest, and
only a declared collection is reachable through `host.personRecords`. Neither
member reaches a collection that belongs to the other.

```jsonc
{
  "openbrf": {
    "personalData": ["apartment", "residency"],
    "personRecords": [
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
    ],
  },
}
```

- `personalData` lists the categories the collection holds, each of them among
  the manifest's own.
- `keepAtMostDays` bounds `eraseOn`, and is at most 1 830 days (five years), the
  bound ADR 0016's update of 2026-10-10 put on a subletting period. A write whose
  `eraseOn` is further than that from the day it is written is refused with
  `PluginRecordRetentionError`. The day must also come after the day of the
  write: today or earlier is refused with a `RangeError`, because the record
  would be due as it was written (see "Which records a plugin can read").
- `fields` names the top-level keys of the value that the access report labels.
  On the report it is for legibility and not a filter: a key it does not name is
  printed as stored.
- `provided` marks a field as something the person gave, such as the space and
  the days they asked for. Only such a field is carried by the portability
  export (see "The access report has one section for every plugin"). A field
  without it, and a key `fields` does not name, is the plugin's own account of
  the person, such as a status it set.
- `titleKey` and each `labelKey` are text keys in the plugin's own namespace, as
  everywhere else in the manifest.

At most eight collections. A plugin that declares any must also ask for
`addressBook:read` (or `addressBook:readContact`), and the manifest and the
catalog entry are refused without it: whether a write naming a person is
accepted is the address book's answer about that person (see "Which person a
plugin may name"). The consent screen shows each collection with its
categories and its bound before anything is downloaded. A republished version
that adds a collection, widens one's categories or lengthens its bound is
refused at load as `personal-data-widened`, and the finding's detail names the
collection.

**One person per record.** A claim is the claimer's record and the offer is the
holder's. Erasure, restriction and the access report act on whole records, so a
record about two people would be erased with the first person's request and
reported on both people's reports. One subject keeps each of those exact. A
plugin that relates two people does it with two records and a key.

**The record refers to the register and does not copy it.** The subject is a
person id. A name, an email address or a telephone number read from the address
book is read again when needed, not stored in the value. The core encrypts email
addresses and telephone numbers (ADR 0002) and a plugin's values are not
encrypted, so a copy would be the one place they are held in plain text. The
host refuses a personal identity number on every write, as it does in
`host.records`. The rest of the rule is declared and read in catalog review, as
ADR 0033's is.

**The record names nobody but its subject.** The access report prints a record
in full on its subject's report, so another person's id, name or apartment in it
would be printed for the subject to read, which GDPR article 15(4) rules out.
The host refuses a key, a string in the value or a property name that is the id
of any person other than the subject, with `PluginRecordOtherPersonError`,
whether or not the address book lists that person to the plugin. Catalog review
reads for the other ways of naming somebody, as it reads for a copied name.

**Which person a plugin may name.** The subject of a new record must be a person
`host.addressBook.residents()` would list to this plugin at the moment of the
write. A record that already names a person may be rewritten with the same
subject after that person has moved out. Any other subject is refused with
`PluginRecordSubjectError`, and the refusal does not say why: a person with
protected personal data, a person under a restriction, a person who objected to
this plugin's processing and an id that names nobody are refused alike.

Whether a subject is accepted is still an answer: it says whether
`residents()` lists the person to this plugin, which `caller` answers only
behind `addressBook:read`. So a plugin that declares
`personRecords` asks for that permission, and `host.audit.record` refuses an
entry with a `subject` from a plugin that holds neither address-book permission,
with `PluginPermissionError` (see "An audit entry can name the person it is
about").

### Where the records live

The records live in ADR 0033's `PluginRecord` table, which changes in three
ways.

- **Three nullable columns:** `subjectPersonId`, `eraseOn` and `setAsideAt`. A
  record about a person has the first two, and a record of `host.records` has
  none of the three.
- **A row has an id of its own, and a key has one live row.** ADR 0033 keyed the
  table by plugin, collection and key. That key becomes a partial unique index
  over the rows whose `setAsideAt` is null, written in the migration's SQL as
  `page_one_front_page` is. Exactly one live row holds a key, and any number of
  rows set aside under the same key may stand beside it (see "A hold or a
  restriction keeps what the plugin replaces"). Every read, every conflict check
  and every write the plugin makes acts on the live row alone. A record of
  `host.records` is never set aside, so for that store nothing changes.
- **`pluginId` is the plugin's id, without a foreign key.** ADR 0033's cascade
  from `InstalledPlugin` would take a held record with the plugin. The column
  holds the manifest id as text, as the plugin's row in the record of processing
  activities does in its `sourceKey`, and the host deletes what removal deletes
  itself (see "Removing a plugin").

The limits count the rows of both stores that the plugin sees: live rows, less
the records about a person whose erase date has come (see "Which records a
plugin can read"). Rows set aside are kept and reported and do not count.

### Who is calling

`host.addressBook` gains `caller`:

```ts
caller(request: ActionRequest): Promise<
  | { kind: "listed"; resident: PluginResident }
  | { kind: "notListed" }
>;
```

The person is the one the host marked on the request, as for `host.actions`, and
the answer is that person as `residents()` would list them, or `notListed`. A
board member who lives elsewhere, a property manager, a former resident, a
person with protected personal data, a person under a restriction and a person
who objected to the plugin's processing are all `notListed`. The plugin learns
that the caller cannot take part and not why, so it can tell the person that the
module is not available to them and to ask the board. The answer does not say
who is protected. It needs `addressBook:read`, as the rest of the address book
does. A plugin that keeps a record about a person learns a little more from
that record than `caller` tells it: see "What a plugin's records tell it"
below.

### Which records a plugin can read

A record is absent from the plugin's reads exactly when its subject is a person
the address book leaves out: a person with protected personal data, a person
under a restriction of processing, or a person with a standing objection to this
plugin's processing (ADR 0035). Absent, not marked. A key such a record holds is
still taken, so a create-only write onto it (`expectedRevision: null`) is
refused as a conflict, which is the true answer: the space is claimed.

Residency is not part of the rule. A moved-out person's records stay readable
until their erase date, as a former resident's bookings do.

**What a plugin's records tell it.** The two rules together let a plugin tell
apart two things the address book alone does not. A person who moves out and a
person who becomes protected, restricted or objecting both leave `residents()`.
The first person's records stay readable, while the second person's leave
`get` and `list`, and their keys stay taken. So a plugin that keeps a record
about a person learns when that person becomes withheld from it, as against
moving out, though not which of the three reasons it is, and nothing about a
legal hold. An erasure on a granted request frees the key, so it reads as
neither. This is accepted, because the alternatives cost more (see "Rejected
alternatives"), and two things bound it:

- The plugin learns it only about a person it keeps a record about, so catalog
  review reads a server bundle's writes to `host.personRecords` for a reason
  in the plugin's features. A plugin that keeps a record about every resident,
  or about a person its features have no use for, is not listed.
- What it learns is one bit, when it changes, and never the reason: the plugin
  cannot tell protected personal data apart from a restriction or an
  objection.

**A record leaves the plugin's view at the start of its erase date**, whoever it
is about, whether the purge has deleted it yet or a hold or a restriction keeps
it. From that day it is absent from `get` and `list`, a `delete` answers
`false`, it does not count against the limits, and its key is free for either
store. A person who has moved out can no longer be named through it, as the
subject of a rewrite or of an audit entry.
A write onto its key clears it out first, as the purge would: it sets it aside
when a hold or a restriction stands, and deletes it otherwise. The host
computes the day as the purge does, on the association's calendar, with one
helper for both.

This applies to a hidden record too: a key that a record about a protected,
restricted or objecting person holds is taken only until the record's erase
date.

The glossary keeps the association's own operational records in the board's
view under a restriction, so the board can handle the request. A plugin's records
follow the rule for what a plugin reads from the register instead, because the
plugin is that reader. The board still sees them, on the access report.

### The host erases, on the record's date and on a granted request

No plugin code runs to purge or to erase. The host's job `PLUGIN_RECORDS_PURGE`
runs at 03:50, after the feed's purge and before the closing job. On every run
it deletes, across every plugin:

- every record whose `eraseOn` has come;
- every record whose subject a granted erasure request names
  (`erasureRequestedPersonIds`, `isErasureInForce`).

It skips the subject of a standing legal hold or restriction. It takes the
people a granted request names first, under the same per-run bound, takes the
legal hold key per person, and selects on the same predicate as every other
domain (ADR 0016).

`pluginRecords` joins `ERASURE_DOMAINS`, so the closing job counts what it still
holds for a person before it closes a request. The job's file is a scheduled
reader of granted requests, so `erasure-domains.spec.ts` and the order test hold
it to both rules without a list kept by hand.

The host runs this rather than calling the plugin, for four reasons:

- A plugin that is switched off refuses every host service. A plugin that failed
  to load runs nothing. A removed plugin has no code. A purge that called into
  the plugin would stop in all three cases, and the closing job would then wait
  for a domain nobody can finish.
- ADR 0016 requires one expression per domain, used both to delete and to count.
  A callback is a second opinion about what "nothing left" means.
- The host owns the table, so it can count what is left. It cannot count what a
  plugin says it deleted.
- The `eraseOn` on every record is the retention rule itself, stated where it
  applies. A hook would hold the same rule in code the host cannot read.

A plugin learns that a record is gone by not finding it.

### A hold or a restriction keeps what the plugin replaces

A legal hold and a restriction each suspend every purge for the person they
stand for. A plugin's own `delete`, and a `put` over a record about such a
person, would otherwise erase what the hold is keeping, and refusing the write
would tell the plugin that a hold exists.

The host therefore accepts the write and **sets the replaced record aside**,
when the live record's subject is under a legal hold or a restriction at the
moment of the write. In one transaction:

- a `delete` stamps `setAsideAt` on the live row, and the key then has no live
  row;
- a `put` stamps the live row the same way and inserts the new value as a new
  live row under the same key, with the replaced row's revision plus one, so the
  plugin sees an ordinary overwrite and its next `expectedRevision` holds.

A hold also keeps a live record past its erase date, because the purge skips the
person. The plugin no longer sees it from that date (see "Which records a plugin
can read"), and a write onto its key sets it aside and starts a new record at
revision 1, as it would after the purge.

A row set aside keeps its subject, erase date, value and revision as they were,
and is never written again. Each overwrite under a hold sets aside one more row,
so every version the hold keeps is a row of its own, and a key deleted under a
hold is free for a create-only write. Of the rows set aside under one key about
one person, the host keeps the first and the last of each day, by the
association's calendar, and deletes the others in the transaction that sets the
next one aside (see the fourth update). Rows set aside are absent from every read
the plugin makes and stay on the person's access report. When the hold or
restriction ends, the purge deletes each one on its first run past its own erase
date, and a granted erasure request reaches them as it reaches a live row.

The limits see an ordinary write too. A `put` that sets the replaced row aside
is checked as an overwrite of that row, because the key still has one live row
afterwards. A `delete` that sets it aside frees the row's place under the
limits, as a delete that removes the row does. So a plugin whose store is full
is refused the same writes whether or not a hold stands.

Switching a plugin off changes none of this. Its records stay, the purge and
erasure carry on, and the access report carries them.

### Removing a plugin

ADR 0033 deleted a plugin's records through the cascade from its
`InstalledPlugin` row, and a record a hold keeps cannot go with that row. So the
host does the deleting itself, in the transaction that deletes the installed
plugin, before the row goes:

- every record of `host.records` is deleted;
- every live record about a person whose subject is under no legal hold or
  restriction is deleted;
- every live record whose subject is under one is set aside, as the plugin's own
  `delete` would set it aside;
- rows already set aside stay as they are.

What stays names the plugin by `pluginId`, which no foreign key ties to the
deleted row. The plugin's row in the record of processing activities is ended
and not deleted, as removal already does, so it still carries the
plugin's name and is the row the kept records belong to. The purge, erasure and
the closing job reach these rows like any other: they go when the hold has ended
and their erase date has passed, and a request is not closed while one is left.

A reinstall under the same id finds them set aside, absent from its reads and
not counted against its limits.

### The access report has one section for every plugin

`DataSubjectReport` gains `pluginRecords`: every record whose subject is the
person, from every plugin that holds one, including records set aside and those
of a removed plugin kept by a hold. Each entry carries:

- the plugin's id and its name;
- the collection's title;
- the record's key;
- each declared field under its label, then every other key of the value as
  stored;
- when the record was written and last changed;
- its erase date, and whether it is set aside.

That is the complete record, whatever the portability export carries of it.

The host builds the section from what it holds and from the plugin's locale
files on the volume, without running plugin code, so a switched-off or broken
plugin's records are reported as fully as a running one's. A removed plugin's
locale files are gone, so its kept records print the plugin's name from its
ended row in the record of processing activities, the collection name, and the
keys as stored.

The section is answered for in the existing ways:

- **ADR 0019.** The subject is stored in `PluginRecord.subjectPersonId`, which
  the column walk finds by its name. `COLUMN_COVERAGE` maps it to
  `pluginRecords`.
- **ADR 0018.** The section's entries name the processing they belong to, which
  is the plugin's own row in the record of processing activities rather than a
  seed key. So `SectionProcessing` gains a third kind, "each entry's plugin's
  row", whose portability is decided per entry and per field as below rather
  than once for the section.
- **Portability.** ADR 0018 carries a section only when its row rests on consent
  or the contract _and_ the section is what the person provided, and within a
  carried section it leaves the association's own account out field by field.
  A plugin's section is held to both bounds by a projection the host owns,
  `PortablePluginRecord` in `data-portability.ts`, read from declarations
  rather than from plugin code:
  - **The basis, per entry.** An entry is `otherBasis` unless the basis the
    plugin's consented manifest declares (`processing.legalBasis`, ADR 0035) is
    `consent` or `contract`. As for the core's sections, the basis is the
    product's statement and not the board's edited copy.
  - **What the person provided, per field.** Of a carried entry, the export
    takes only the fields the collection's declaration marks `provided`. A field
    declared without it, and a key the declaration does not name, is the
    plugin's account and stays on the report, as a board's note stays off a
    subletting application. A collection that marks no field `provided` is
    `notProvided` as a whole.
  - **What else travels.** The plugin's id and name, the collection's title and
    the record's key, beside the provided fields. Not the erase date, the
    revision or the change times, which are the host's account of the record,
    as a booking's purge date is.
  - **Live records only.** A row set aside is not carried. It is kept for the
    hold or the restriction and not for the processing the basis covers, and it
    stays on the report. A removed plugin's records are all set aside, so the
    export never needs the basis of a plugin that is gone.

A plugin that keeps records about a person must declare `processing`, so every
such record has a row to belong to.

### An audit entry can name the person it is about

ADR 0035's `host.audit.record` takes one optional `subject`, held to the rule a
record's subject is held to. The host writes it as the entry's target person, so
the entry reaches that person's access report through the audit log, beside
every core entry that names them. The detail still never names a person, and the
actor is still the person marked on the request.

A `subject` needs `addressBook:read` or `addressBook:readContact`, because
whether it is accepted says whether the person is listed. Without either the
entry is refused with `PluginPermissionError` before the subject is checked. An
entry without a subject needs no permission, as before.

The host writes no entry for an ordinary `put` or `delete`. ADR 0008 keeps the
choice of what to record with whoever makes the change: a generic "record
written" entry would bury the claim the plugin chose to record. The host writes
its own entries for its own acts:

- `PLUGIN_RECORDS_PURGED`, once per run that deleted anything, with counts per
  plugin and collection and no person. The closing job's entry names
  `pluginRecords` among the domains it verified empty, as it does for the
  others.
- `PLUGIN_REMOVED` gains the counts deleted and set aside.

### Feature detection

`host.personRecords` and `host.addressBook.caller` are added after contract
version 1 shipped, and a plugin detects both. `host.audit` takes `subject` from
the release that adds `host.personRecords`, so a plugin detects one by the
other. An instance that predates this ADR ignores the `personRecords` field of
the manifest, because the manifest is not read strictly. Nothing on such an
instance can hold a record about a person, so a plugin that needs one fails at
its own feature check and keeps nothing. The catalog entry carries
`personRecords` in the same index version as ADR 0035's `processing`, because
the consent screen has to show it before the download.

## Consequences

- A paid module can keep its own records about a person through the public
  API, and the association can report them, erase them on a date and on
  request, hold them and restrict them, as it does its own.
- One table gains a person column, and all four guards hold it as they hold any
  other: the column walk, the section map, the erasure registry and the order
  test.
- That table's identity changes for both stores: a row id, a partial unique
  index on the live rows, and a plugin id with no foreign key. The migration
  writes the partial index in SQL, as it writes the website's one front page.
- A plugin's purge does not depend on the plugin. Removal deletes what is not
  held and ends the processing row, as before, but it is the host's code that
  deletes rather than a cascade, so removing a plugin from the database by hand
  leaves its records behind.
- The portability export carries a plugin's records only as far as its
  declaration marks fields `provided`. A plugin that marks none is reported in
  full and exported not at all, and catalog review reads the marks as it reads
  the categories.
- The access report grows a section whose content the plugin shapes and the host
  prints. A plugin with poorly chosen keys produces a poorly legible section, but
  never an incomplete one.
- The set-aside rule means that a delete under a hold frees the plugin's place
  under its limits but not the storage. What a hold keeps of one record grows by
  at most one row, of at most 64 KiB, for each day it is rewritten or deleted,
  beside the first version the hold replaced. It is held to no limit beyond
  that: a plugin that writes and deletes ever new keys about a held person adds
  a row for each, for as long as the hold stands. The person's access report
  shows every row kept, and not the versions of a day that were replaced
  before its last.
- Restoring a backup brings back records erased after it was taken, as it does
  for every core table. This ADR changes nothing about that.
- A moved-out person keeps their records until the erase date the plugin chose,
  within its declared bound. The core's 365 days after move-out does not shorten
  them, as it does not shorten a booking.
- A plugin that keeps a record about a person learns when that person becomes
  withheld from it, as against moving out (see "What a plugin's records tell
  it"). Catalog review holds a plugin to keeping records only where a feature
  needs them, and that review is the only bound on it.
- Personal-data categories beyond the manifest's five, such as a booking's
  dates, wait on the shared list the broker package's gap G11 proposes. Until
  then a collection declares the nearest of the five.

## Rejected alternatives

- **Personal data in `host.records`, with `subject` and `eraseOn` as options.**
  An instance with ADR 0033's store and not this one would accept the write and
  drop the options, keeping personal data with no retention and no report. A
  separate member makes "this instance cannot" detectable.
- **A purge hook and a report hook called into the plugin.** See "The host
  erases" above. A report contribution that runs plugin code is incomplete
  exactly when the plugin is switched off or broken, which is when a board is
  most likely to be asked.
- **Tables shipped by the plugin.** Rejected by ADR 0033 for its own reasons, and
  the runtime role cannot create them.
- **Several subjects per record.** One person's erasure would take another
  person's record with it, and a restriction of either would hide it from both.
- **Telling the plugin why a person is not listed.** The plugin would learn who
  has protected personal data and who objected to it.
- **Showing a withheld person's records as a moved-out person's are.** It
  removes what a plugin's records tell it, but it shows a plugin the records of
  a person under a restriction or with a standing objection, which ADR 0035
  keeps from it (GDPR articles 18 and 21).
- **Hiding a moved-out person's records too**, keeping their keys taken until
  the erase date. Moving out and being withheld would then look the same to the
  plugin. But a former resident's records would no longer be readable, as a
  former resident's bookings are, and a plugin could no longer close or record
  a moved-out person's claim.
- **Refusing a write under a hold.** It tells the plugin about the hold, and
  breaks an ordinary action, such as withdrawing an offer, for a reason the
  person cannot see.
- **Counting rows set aside against the limits.** It refuses a write under a hold
  whenever the store is full, and so tells the plugin about the hold. See the
  update of 2026-10-24.
- **Reserving headroom for rows set aside.** It hides the hold only until the
  reserve is spent, and from then on the limits tell the plugin about it again.
- **Keeping a record visible until the purge deletes it.** The purge skips a
  person under a hold or a restriction, so their record would outlive its date
  and tell the plugin about the hold. See the second update of 2026-10-24.
- **Accepting an erase date of today or earlier.** The record would be due as it
  was written: the plugin could never read it, and the limits would not count
  it, so a plugin could write any number of them before the purge came.
- **Keeping the replaced versions in a second table.** It would be a second
  table with a person column, a second section source and a second erasure
  domain for what is the same record at another revision. One table with one
  live row per key holds the same thing.
- **Keeping the cascade and moving held records out before removal.** The same
  second table, reached by one more path.
- **Carrying every record on the basis alone.** ADR 0018's second bound, what
  the person provided, would hold for the core's sections and not for a
  plugin's, and a status or a decision the plugin set would travel in the
  person's file as if they had given it.

## Revisit triggers

- **A plugin needs to query its records by something other than the key or the
  subject**, such as a range of dates over more records than a list can page
  through in a request.
- **A plugin needs more than 10 000 records**, which a booking module on a large
  association could reach within its retention window.
- **A record needs to be kept past a granted erasure**, as an open motion or a
  running subletting is in the core (ADR 0016): a `kept` clause per collection.
- **A plugin needs a record about a person who is not a resident**, such as a
  visitor.
- **What a hold keeps for one plugin grows past what an instance can store**,
  for example from a plugin that writes and deletes ever new keys about a held
  person. The answer must not refuse the plugin's writes. It could alert the
  board when what is kept for one person passes a threshold.

## Update, 2026-10-24

As first accepted, this record counted every row against the limits, live or set
aside. A `put` that set the replaced row aside was checked as one more row,
while an ordinary overwrite of the same size was not checked at all. A plugin
could fill its store to exactly 10 000 records or 16 MiB, overwrite a record
about a person, or delete it and write it again, and read a
`PluginRecordLimitError` as "this person is under a legal hold". Refusing a
write under a hold is rejected above because it tells the plugin about the
hold, and the limits brought that signal back.

The limits now count live rows only. Rows set aside are still stored, reported
and purged as described above. The host checks a `put` that sets a row aside
exactly as it checks an overwrite, so whether the limits refuse a write does not
depend on whether a hold stands. The cost is that storage kept under a hold has no
bound of its own (see "Consequences" and the revisit trigger).

## Second update, 2026-10-24

After the first update, the plugin still saw a live record until the purge
deleted it, and the purge skips anybody under a legal hold or a restriction. A
plugin could write a record about a person with `eraseOn` set to today and look
for it the next day. If the record was gone, the person was not held. If it was
still there, they were. The same answer came through the limits, through a
create-only write onto the key, through `PluginRecordSubjectError` once the
person had moved out, and through the subject of an audit entry. For a person
hidden from the plugin, it also told a restriction apart from protected
personal data or an objection, because only a restriction kept the key taken.

A record now leaves the plugin's view at the start of its erase date (see "Which
records a plugin can read"). That moment depends only on the date, not on
whether the purge has run or on what it skipped. A write onto the key clears the
record out as the purge would, setting it aside under a hold. An erase date of
today or earlier is refused, because the plugin could not see such a record and
the limits would not count it. The board's view does not change: the record
stays on the access report and goes with the purge once nothing keeps it.

## Third update, 2026-10-24

A security review found that a plugin's own records tell it something the
address book does not. A person who moves out keeps their records readable
until the erase date, and a person who becomes protected, restricted or
objecting does not, so a plugin that writes a record about a person can later
tell which of the two happened. It also found that whether a subject is
accepted, by `host.personRecords.put` or by `host.audit.record`, answers "is
this person listed?", which `caller` answers only behind `addressBook:read`.

The first is kept and stated: "What a plugin's records tell it" says what the
plugin learns and what bounds it, and "Rejected alternatives" says why neither
way of removing it was taken. The second is closed. A manifest or a catalog
entry that declares `personRecords` without an address-book permission is
refused, and an audit entry with a `subject` from a plugin without one is
refused with `PluginPermissionError`, so the consent screen shows the board
what the plugin can learn.

## Fourth update, 2026-10-24

A security review found two more gaps.

The access report printed every value as stored, so a record about one person
could print another person's id on the first person's report, against GDPR
article 15(4). A plugin that relates two people was told to do it with two
records and a key, but nothing held it to that. The host now refuses a key, a
string in the value or a property name that is the id of any person other than
the subject (see "The record names nobody but its subject"). It asks after
every person alike, listed to the plugin or not, so the refusal tells the plugin
nothing about a person beyond what holding the id already did. An id inside a
longer string is left to catalog review.

What a hold kept had no bound: a plugin that updated a status on every request
about a held resident added one row for each request, for as long as the hold
stood. Refusing the writes would tell the plugin about the hold, so the host
now keeps fewer of the versions instead. Of the rows set aside under one key
about one person it keeps the first, which is what the record said when the hold
first touched it, and the last of each day on the association's calendar, and
deletes the rest in the transaction that sets the next one aside. A thousand
rewrites in one day keep at most two rows of that day. Rows set aside do not count against the
limits, and the plugin cannot read them, so it cannot tell whether any were
deleted. The versions replaced within a day are lost to the hold, which is the
price of the bound. A plugin that writes and deletes ever
new keys still adds a row for each, and stays a revisit trigger.
