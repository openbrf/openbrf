---
"@openbrf/api": patch
---

Read `+46 (0)70 123 45 67` as the same phone number as `070-123 45 67`.

The common spelling that keeps the trunk zero in brackets beside the country
code, with `+46` or `0046`, normalised to `+460701234567`, so register search
and the import's duplicate check did not match it with the same number written
any other way, and a text message went to a number that does not exist. The
zero after `+46` is now dropped. People stored before the upgrade are
reindexed by the same job at start as the personal identity number change.
