---
"@openbrf/api": patch
---

Two first-administrator submissions sent at the same instant can no longer both
succeed. The check that the instance is unclaimed is taken under the lock every
change to the administrators takes, and counts ADMIN grants as well as accounts,
so the second submission is refused with `already-claimed`.
