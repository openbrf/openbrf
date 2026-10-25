---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
---

A plugin's record about a person can no longer name somebody else, and what a
legal hold keeps of a plugin's records has a bound (ADR 0047).

- `host.personRecords.put` refuses a record whose key, property names or text
  values hold the id of any person in the register other than the record's
  subject, with the new `PluginRecordOtherPersonError`. The person's access
  report prints the record in full, so it must not tell them about anybody
  else. An id is found on its own or set off by other characters, as in
  `offer:<id>`, and one joined with `-` or `_` is found too. An id that is
  encoded or reversed is not, and is left to catalog review. Every person
  counts the same, so the refusal tells the plugin only that a string is
  somebody's id.
- While a legal hold or a restriction stands, a record the plugin overwrites
  or deletes is set aside at most once a day: the version the day's first
  write replaced is kept, and later writes that day act in place. A plugin
  that rewrites a held person's record on every request no longer adds a row
  each time. The plugin sees the same revision, limits and answer as before.
