---
"@openbrf/api": minor
"@openbrf/i18n": patch
---

The first work order mailed to a contractor now links the association's
privacy notice on its website, as GDPR art. 14(3)(b) asks, and a later one
does not. A contractor counts as told once the mail server has accepted a mail
that carried the link. After the board changes the contractor's name or email
address, the next work order carries the link again. While the privacy notice is not published, a work order goes without
the link, and the next one after it is published carries it.

The nightly issue purge now removes a contractor from the list ten years after
the last work order sent them, or ten years after they were added if none was.
The removal works as the board's own does, and also clears the contractor's
name and address from the work orders sent them. A contractor is kept while a
work order sent them still holds its text or is on an issue under a legal
hold. A work order's text keeps its own ten years after its issue was closed.

The record of processing activities' text for issues gives the legal basis for
the contractor list: the contract for a sole trader, and legitimate interest
for a firm's contact person. It also states the list's ten-year clock. The
contractor list's description says the same, in Swedish and English.
