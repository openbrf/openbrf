---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

The board's report queue reads itself again when a press is answered with "that
report does not exist", for example for a report the purge removed, instead of
refusing every press until the page is reloaded. The notice for a reporter past
their allowance no longer calls ten reports in an hour "a great many".
