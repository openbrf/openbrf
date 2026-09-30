---
"@openbrf/api": patch
---

Harden the sign-in library's user-update surface.

The library's own user-update endpoint, which this product does not use, now
answers 404. The account's `personId` is declared as set by the application
only, and a test requires every user field the application or a plugin adds to
be declared the same way unless it is on an explicit list, which is empty.
