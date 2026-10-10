---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

State on the access report that a restriction of processing suspends the purge,
as a legal hold does. The retention section named only holds, so a person under
a restriction read a purge date as something that was going to happen. It now
carries `processingRestricted` beside `onLegalHold`, and the screen shows both.
