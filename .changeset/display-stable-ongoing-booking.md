---
"@openbrf/display": patch
---

Keep a screen's content, and so its `ETag`, the same while a booking is under
way. `buildRotation` now takes a busy interval that began at or before the
moment of the fetch from the start of the availability window, the minute of the
fetch, where it used to keep the start to the second. A screen fetched twice in
one minute is answered 304 the second time, where an ongoing booking made every
fetch a new document.
