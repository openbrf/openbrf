---
"@openbrf/shared": patch
"@openbrf/api": patch
"@openbrf/web": patch
---

The lengths the address, apartment, issue type and bookable resource forms and the first-boot administrator form allow, and the shortest password an account may have, are now shared between the forms and the server that enforces them (`ADDRESS_LIMITS`, `BOOKABLE_RESOURCE_LIMITS`, `ISSUE_TYPE_LIMITS`, `ADMINISTRATOR_LIMITS` and `MIN_PASSWORD_LENGTH` in `@openbrf/shared`), so the two cannot drift apart. No limit changes.
