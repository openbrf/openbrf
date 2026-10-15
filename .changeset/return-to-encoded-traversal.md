---
"@openbrf/web": patch
---

The address signing in returns to is now refused when an encoded traversal such as `/%2e%2e/%2e%2e//example.test` would turn it into a path starting with `//`, whether as written or after the extra decode the emailed sign-in link applies. Signing in then lands at the start of the application, as for any other refused address.
