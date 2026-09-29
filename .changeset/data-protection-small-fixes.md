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
- An apartment binder title is scanned and stored without invisible characters
  that could hide a personal identity number.
- A board member no longer sees "Ta ut" on an entry they filed for the board into
  their own apartment, which the take-out refused.
- A file that a failed filing could not remove is logged, in the binder and the
  archive.
