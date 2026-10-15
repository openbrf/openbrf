---
"@openbrf/web": patch
"@openbrf/api": patch
---

Activating an invitation now refuses a password longer than the 128 characters sign-in accepts. Before, a longer one created an account that could never sign in. The activation form stops at the shared limits, and creating an account for a person checks them itself, so no other route to it can repeat the mistake.
