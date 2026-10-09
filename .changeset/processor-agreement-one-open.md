---
"@openbrf/api": patch
---

Hold the record of processors to one current classification per recipient.

The database now refuses a second open classification for a recipient. Before
this, only the code that writes one kept that rule. An instance that already
has two open classifications for one recipient, which two classifications
recorded at the same moment on an older version could leave, keeps the newest.
Each older one is closed as replaced at the moment the next was recorded, so it
stays in the record's history. Nothing is deleted.
