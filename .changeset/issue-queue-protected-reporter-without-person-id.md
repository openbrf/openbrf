---
"@openbrf/api": patch
"@openbrf/web": patch
---

The protected reporter in the issue queue no longer carries the person's id, so
a handler cannot use that id to link a protected row to an earlier row where the
same person was shown. The location and description stay in the row, so a
distinctive one can still point to the same reporter.
