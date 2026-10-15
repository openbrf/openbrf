---
"@openbrf/shared": patch
"@openbrf/api": patch
"@openbrf/web": patch
---

The lengths the housing cooperative's name, the bankgiro and plusgiro numbers and the SMS sender name may have are now shared between the settings forms and the server that enforces them (`HOUSING_COOPERATIVE_LIMITS`, `FINANCE_LIMITS` and `SMS_LIMITS` in `@openbrf/shared`), like the other settings lengths. No limit changes.
