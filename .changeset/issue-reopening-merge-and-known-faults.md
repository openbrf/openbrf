---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

What happens to an issue after it closes, merging duplicates, and known faults.

- **Reopening by a reply.** A reporter who replies within 30 days of an issue
  closing reopens it. The issue goes back to its type's default in-progress
  status, keeps its assignee, and loses its outcome and closing date, which
  restarts nothing until it closes again. The timeline says the reporter
  reopened it without naming them. A reporter without an account reads
  and writes through their private link, and a message there reopens the issue
  the same way, within the same 30 days, and alerts its assignee. Which status a reopened issue enters is
  still an open question for the owner (ADR 0054, question 2); in progress is
  the interim answer.
- **A new report after the window.** After 30 days, or on a report merged into
  another, the reply field gives way to a new report linked to the old one.
  The link is the reporter's own closed issue and nobody else's, and it
  survives the old issue being purged. Handlers see both issues linked.
- **Merging duplicates.** A handler merges an issue into another it handles
  that is still being handled: a done issue is refused as the one merged into,
  and reopened first if it is the one wanted. The issue merged may be done
  already, and then keeps its closing date. The duplicate closes with the outcome Duplicate, which only merging writes.
  Its reporter keeps their own report and sees where the other issue stands. A
  handler can write one message to the reporters of the merged reports they
  handle: each gets it on their own report, signed by the board or the
  property manager, and the handler is told how many merged reports were not
  reached because none has a reporter with an account. At most 200 issues can
  be merged into one. No reporter reads another's report, and a reporter with protected personal
  data stays masked. Reopening a duplicate, or closing it again with another
  outcome, undoes the merge.
- **Known faults.** A handler publishes a short known fault on an open issue,
  up to 280 characters, in their own words. It is signed by the board or the
  property manager, never a person. Signed-in residents see it above their
  report form and on the post the issue was reported from. It never appears on
  the public website or on an issue the board keeps to itself, and it goes when
  the issue closes. Publishing and withdrawing one is recorded in the audit
  log without the text.

Text a handler writes, a known fault or a message to the merged reporters, is
refused while it carries a personal identity number. None of this is offered to
a connected app or the AI package.

A reply that reopens an issue mails its assignee, or everybody who handles it
when it has none, that it is open again, as any reopening does. A message to the
reporters of merged reports mails each reporter that there is a new message.
Neither mail says what the message says. A known fault is mailed to nobody.
