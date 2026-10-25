---
"@openbrf/display": patch
---

Keep a screen's content, and so its `ETag`, the same while a booking is under
way, also when the busy read ran after the moment the caller passed as `now`.
`buildRotation` now takes a busy interval that starts within the minute of the
availability window's start from that start, where it took only one that began
at or before `now`. A booking that starts later than the first minute of the
window keeps its start to the second.
