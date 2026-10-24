---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

A plugin can now keep records about a resident through `host.personRecords`
(ADR 0047). Open BRF looks after those records the way it looks after its own
bookings.

A plugin declares each collection in its manifest under `personRecords`, with
the categories of personal data it holds, how many days a record may be kept
(at most 1 830) and the fields the data subject access report labels. A
plugin that declares one also declares its `processing`. The install consent
screen and `openbrf plugin add` name each collection with its categories and
its bound, and the install refuses an entry that changed them in between. A
republished version that adds a collection, holds more categories in one or
keeps a record longer is not loaded until the board installs it again
(`personal-data-widened`). The field is in version 2 of the catalog index.

Every record names one person and the day it is erased, which must come after
the day of the write. A new record may name only a resident the address book
lists to the plugin. A record about somebody
with protected personal data, under a restriction of processing, or objecting
to the plugin's processing is hidden from the plugin.

- A record is gone from the plugin's view from the start of its erase date. A
  nightly job at 03:50 erases each record on its day, and erases every record
  about a person whose erasure request the board granted, without running the
  plugin's code. The request stays open until none is left.
- A legal hold or a restriction stops both. While one stands, a record the
  plugin overwrites or deletes is set aside instead and kept, and so is a
  record past its erase date. Neither is visible to the plugin or counts
  towards its limits, so the plugin cannot tell from its records or its limits
  that a hold stands.
- Removing a plugin deletes its records itself, rather than through the
  database, and sets aside the records a hold or a restriction keeps. The
  audit entry for the removal says how many it deleted and how many it set
  aside.
- The data subject access report has a new section listing every record a
  plugin keeps about the person, set-aside ones and those of a removed plugin
  included. It is labelled from the plugin's own translations even when the
  plugin is switched off.
- The portability export carries a record only where the plugin's processing
  rests on consent or the contract, and then only the fields the plugin marks
  as given by the person.

A plugin's own records (`host.records`) now refuse a collection declared under
`personRecords`.

`host.addressBook.caller(request)` answers whether the person making a request
is a resident the plugin may serve, without saying why when they are not.
`host.audit.record` takes a `subject`, so an entry reaches the access report of
the person it is about.

The reference plugin in `fixtures/example-plugin` lets a resident note the days
they are away, kept for 30 days after the last of them.
