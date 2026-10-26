---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
---

A plugin's compare-and-set on a record about a person can now name the record
as well as its revision (ADR 0047).

A record's revision starts again from 1 when its key is written anew, after a
delete or after the host erased the record on its erase date or on a granted
erasure request. A write over a revision read before that could land on a
record written since that had reached the same revision. Each record that
`host.personRecords` returns now carries an opaque `identity`, which stays the
same on every write over the record, a write a legal hold sets aside included,
and is new for a record written anew. `put` and `delete` accept it as
`expectedIdentity`, beside `expectedRevision` or on its own, and refuse a
different record with `PluginRecordConflictError`. A write without it is
checked as before.
