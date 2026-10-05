---
"@openbrf/api": patch
---

Keep one connected-app consent per member and app. Two consents submitted at
the same moment could leave two rows granting different things; a unique index
now refuses the second. The migration first merges any duplicates already
stored into the earliest row, keeping only what every one of them granted, so
an app may ask an affected member to consent again.
