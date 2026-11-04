---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

A handler can remove the text of a work order, as they can remove the rest of
an issue's free text (ADR 0057).

- **Where.** In the record of an issue's work orders, each work order whose
  text still stands offers its removal, asked twice. The text is gone for good,
  and the work order reads "Removed by a handler" with the date. The work order
  stays, with whom it went to (unless the contractor has since been removed
  from the list, which clears their name and address from every work order sent
  them), when, who sent it and whether the mail went out.
- **Refused under a legal hold.** While a legal hold stands on the issue,
  nothing is offered, and the server refuses a removal.
- **A mail not yet sent.** A work order whose mail had not gone out when its
  text was removed is not sent, and is recorded as not sent because its text
  was erased.
- **The record.** The audit log records the removal against the issue, with
  the work order's identifier and none of its words, and the issue's timeline
  shows it.
- **The reporter link.** When the removal leaves an issue with no text at all,
  and its reporter's erasure request has already been carried out, the issue
  stops naming them at once, as the nightly erasure of a work order's text
  already did. A legal hold or a restriction of processing on the reporter
  keeps the link.
