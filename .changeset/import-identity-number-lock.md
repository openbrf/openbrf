---
"@openbrf/api": patch
---

Close the last gap in the import's check for a person entered twice. Adding a
person from the address book with a personal identity number now takes a lock
on that number, and an import chunk takes the same lock for every number it
writes before it checks the register again. A person added with a row's number
while the chunk runs is either seen by the check, which stops the import, or
added after the chunk commits. The lock is keyed by the number's blind index,
so the number itself never reaches the database's lock table.
