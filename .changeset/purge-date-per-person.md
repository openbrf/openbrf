---
"@openbrf/api": patch
---

Show the board the date the purge will act on a person, not the date a single
residency ended. The purge waits for the last residency to end and leaves a
person alone while they hold a board seat or a system role, or while a legal
hold or a restriction stands, so a person who moved to another apartment no
longer shows a past date on the old row, and a person the purge will not touch
shows none.
