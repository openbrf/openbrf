# ADR 0037: A plugin's records about a person

Date: 2026-10-19

## Status

Accepted. Builds on [ADR 0033](0033-a-plugin-s-own-records.md), whose store
stays free of personal data, and on
[ADR 0035](0035-a-plugin-s-processing-and-objecting-to-it.md), whose
`processing` declaration and `host.audit` it extends. Answers ADR 0033's
revisit trigger "a plugin needs to keep personal data".

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

A value is a JSON object, so that the access report can label its keys. The
records live in ADR 0033's `PluginRecord` table, which gains three nullable
columns: `subjectPersonId`, `eraseOn` and `setAsideAt`. A record about a person
has the first two, and a record of `host.records` has none of the three.

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
          { "key": "space", "labelKey": "records.claims.space" },
          { "key": "from", "labelKey": "records.claims.from" },
          { "key": "to", "labelKey": "records.claims.to" },
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
  `PluginRecordRetentionError`. A day already past is accepted, and the record
  goes on the next run.
- `fields` names the top-level keys of the value that the access report labels.
  It is for legibility and not a filter: a key it does not name is printed as
  stored.
- `titleKey` and each `labelKey` are text keys in the plugin's own namespace, as
  everywhere else in the manifest.

At most eight collections. The consent screen shows each one with its
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

**Which person a plugin may name.** The subject of a new record must be a person
`host.addressBook.residents()` would list to this plugin at the moment of the
write. A record that already names a person may be rewritten with the same
subject after that person has moved out. Any other subject is refused with
`PluginRecordSubjectError`, and the refusal does not say why: a person with
protected personal data, a person under a restriction, a person who objected to
this plugin's processing and an id that names nobody are refused alike.

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
module is not available to them and to ask the board. It cannot report who is
protected. It needs `addressBook:read`, as the rest of the address book does.

### Which records a plugin can read

A record is absent from the plugin's reads exactly when its subject is a person
the address book leaves out: a person with protected personal data, a person
under a restriction of processing, or a person with a standing objection to this
plugin's processing (ADR 0035). Absent, not marked. A key such a record holds is
still taken, so a create-only write onto it (`expectedRevision: null`) is
refused as a conflict, which is the true answer: the space is claimed.

Residency is not part of the rule. A moved-out person's records stay readable
until their erase date, as a former resident's bookings do.

The glossary keeps the association's own operational records in the board's
view under a restriction, so the board can handle the request. A plugin's records
follow the rule for what a plugin reads from the register instead, because the
plugin is that reader. The board still sees them, on the access report.

### The host erases, on the record's date and on a granted request

No plugin code runs to purge or to erase. The host's job `PLUGIN_RECORDS_PURGE`
runs at 03:50, after the feed's purge and before the closing job. On every run
it deletes, across every plugin:

- every record whose `eraseOn` has passed;
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

The host therefore accepts the write and **sets the replaced record aside**. The
key is free again, the record is absent from every read the plugin makes, and it
stays on the person's access report. When the hold or restriction ends, the
purge deletes the record on its first run past the record's own erase date.
Removing a plugin sets aside the same records, and deletes the rest.

Switching a plugin off changes none of this. Its records stay, the purge and
erasure carry on, and the access report carries them.

### The access report has one section for every plugin

`DataSubjectReport` gains `pluginRecords`: every record whose subject is the
person, from every plugin that holds one, including records set aside and those
of a removed plugin kept by a hold. Each entry carries:

- the plugin's id and its name;
- the collection's title;
- each declared field under its label, then every other key of the value as
  stored;
- when the record was written and last changed;
- its erase date, and whether it is set aside.

The host builds the section from what it holds and from the plugin's locale
files on the volume, without running plugin code, so a switched-off or broken
plugin's records are reported as fully as a running one's. A removed plugin's
locale files are gone, so its kept records print the collection name and the
keys as stored.

The section is answered for in the existing ways:

- **ADR 0019.** The subject is stored in `PluginRecord.subjectPersonId`, which
  the column walk finds by its name. `COLUMN_COVERAGE` maps it to
  `pluginRecords`.
- **ADR 0018.** The section's entries name the processing they belong to, which
  is the plugin's own row in the record of processing activities rather than a
  seed key. So `SectionProcessing` gains a third kind, "each entry's plugin's
  row".
- **Portability.** An entry is carried by the portability export when the basis
  the plugin's manifest declares (`processing.legalBasis`, ADR 0035) is
  `consent` or `contract`, and stays on the access report otherwise. As for the
  core's sections, the basis is the product's statement and not the board's
  edited copy.

A plugin that keeps records about a person must declare `processing`, so every
such record has a row to belong to.

### An audit entry can name the person it is about

ADR 0035's `host.audit.record` takes one optional `subject`, held to the rule a
record's subject is held to. The host writes it as the entry's target person, so
the entry reaches that person's access report through the audit log, beside
every core entry that names them. The detail still never names a person, and the
actor is still the person marked on the request.

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
- A plugin's purge does not depend on the plugin. Removal deletes what is not
  held and ends the processing row, as before.
- The access report grows a section whose content the plugin shapes and the host
  prints. A plugin with poorly chosen keys produces a poorly legible section, but
  never an incomplete one.
- The set-aside rule means that a delete under a hold does not free the storage.
  Those records count against the plugin's 10 000 and 16 MiB until the hold
  ends.
- Restoring a backup brings back records erased after it was taken, as it does
  for every core table. This ADR changes nothing about that.
- A moved-out person keeps their records until the erase date the plugin chose,
  within its declared bound. The core's 365 days after move-out does not shorten
  them, as it does not shorten a booking.
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
- **Refusing a write under a hold.** It tells the plugin about the hold, and
  breaks an ordinary action, such as withdrawing an offer, for a reason the
  person cannot see.

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
