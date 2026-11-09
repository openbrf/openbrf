---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

A handler records whom an issue concerns: the residents an issue is about who
did not report it, such as the neighbour a report of a disturbance names. It
works on an issue of any type.

- **Picked as a resident is picked.** The handler chooses an apartment and then
  who lives there today, as when opening an issue for a resident. The list
  shows each person by name, or says that the name is protected. An issue names
  at most ten people this way. A handler takes a person off the list as a
  removal, asked twice.
- **Read by the handlers alone.** Only those who handle the issue see the list.
  The reporter, the mails, a work order and the links carry none of it. An
  issue concerning a person with protected personal data is left out of what a
  connected app or the AI package reads, and a contractor's link to it ends.
  The audit log and the timeline say that a person was recorded, never whom.
- **Purged with the issue's free text.** The record is personal data about the
  person named, so it is removed with the description and the conversation, on
  the issue's clock or on the reporter's granted erasure request. Whatever keeps
  that text keeps the record too. A legal hold or a restriction on a person an
  issue concerns now keeps the issue's free text, as one on its reporter does:
  the clock skips the issue, the reporter's erasure request counts it as kept,
  and a handler cannot remove its text. The record of processing activities
  and the board's settings say so in Swedish and English.
- **Not yet on that person's access report.** A later change carries such a
  case to the person it concerns, without the reporter.
