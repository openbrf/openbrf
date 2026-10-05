---
"@openbrf/api": patch
---

Prepare one export of a person's own data (`POST /api/data-portability/mine`)
at a time for each person.

No more than three exports are prepared at once for the whole instance, but one
person could ask for all three in the same instant and hold every slot, and
everybody else's export was then refused as busy until those three finished. A
second export asked for while the person's first is still being prepared is now
refused with the same 429 and `export-busy` reason, takes nothing from their
budget of three a minute, and leaves the other slots to everybody else.

A request refused as busy was always told `Retry-After: 1`, even when the
instance's budget of twelve exports a minute was spent too, so its retry was
refused again with the real wait. It is now told the longer of the two. A second
stays the shortest wait, rather than the thirty seconds the report's transaction
may take at most: an export usually takes well under a second, and a retry that
is refused again costs only the check.
