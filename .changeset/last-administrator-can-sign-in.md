---
"@openbrf/api": patch
---

Count only administrators who can sign in when refusing to remove the last
one. A grant on a person with no account no longer lets the last
administrator who can sign in revoke their own grant.
