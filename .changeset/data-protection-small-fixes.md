---
"@openbrf/api": patch
---

Smaller data protection fixes:

- A data subject request stays open all of its due day on the association's
  calendar, instead of turning overdue at 02:00 that day.
- The people named when a breach is recorded each get the audit entry that puts
  the breach on their access report, as a person added later does.
- A breach decision's delay reasons are scanned for a personal identity number,
  as an update's are.
- An apartment binder title is scanned and stored after the same folding of
  invisible and lookalike characters, and a title that is empty after it is
  refused.
- The person page promises an erasure only where the nightly jobs will carry it
  out, not for a sitting board member, a resident or a system-role holder.
- A board member no longer sees "Take out" on an entry they filed for the board
  into their own apartment, which the take-out refused.
- A file that a failed filing could not remove is logged, in the binder and the
  archive.
