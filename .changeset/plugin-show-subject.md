---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A record a plugin keeps about a person can show that person's name, and a
resident's apartment, to the others the plugin serves, when the person chooses
it (ADR 0053).

In a collection that declares `showsSubject`, a write to
`host.personRecords.put` may set `showSubject`. The host stores it in a column
of its own and takes it only from a write made in the signed-in session of the
person the record is about: there the write's value counts, and leaving it out
withdraws it. A write from anybody else's session, a job, a connected app's
token or a support session cannot set or withdraw it. A rewrite by somebody
else keeps the stored flag, and a write that gives the record to somebody else
stores it as false. `showSubject: true` in a collection without `showsSubject`
is refused.

`get` and `list` return `showSubject` on every record and, on a record whose
flag is set, `shown` with the name and the apartment (null for a person served
in a class of caller), read from the register on that request with the same
check the resident route's guard makes. A subject who moves out, becomes a
former resident, loses their board seat or system role, or whose class the
install no longer serves, has no `shown` on the next read. The plugin never
stores the name. The person's access report says, record by record, whether
they chose to be shown.
