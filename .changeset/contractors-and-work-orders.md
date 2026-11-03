---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

A handler can send a work order about an issue to a contractor, by mail, after
a preview, and the issue keeps the record of it (ADR 0055).

- **The contractor list.** The board keeps the firms it hires in the settings,
  under Issues and bookings: a name, a trade, a telephone number and an email
  address. A contractor with no address stays on the list but cannot be mailed
  a work order. A contractor switched off is no longer offered, and one removed
  from the list leaves the work orders already sent them. Every handler,
  the property manager included, chooses from the list; only those who
  configure the issue types change it.
- **Writing and previewing.** On an issue, a handler chooses a contractor,
  writes what is to be done and where, and previews the mail as the contractor
  will receive it before sending. Changing the text or the contractor drops the
  preview, so what is sent is what was read. The preview says when this
  instance has no mail server set up.
- **What the mail carries.** The handler's text and nothing else from the
  issue: never the report, the place the reporter wrote, the reporter, the
  photographs or a link into the application. A text holding a personal
  identity number is refused. When the reporter has protected personal data,
  the form warns the handler to keep their name and home out of it.
- **The record.** Each work order is stored on the issue before it is mailed,
  with whom it went to, when, what it said and who sent it, so the association
  can answer who received a person's data (GDPR art. 15(1)(c) and 19). The
  issue's handlers read it, with whether the mail went out and, if not, why.
  The timeline shows that a work order was sent, and the audit log records the
  sending with the length of the text and none of its words.
- **Ring-fenced types.** A work order on an issue whose type is ring-fenced is
  refused in the service, its preview included. Nothing in the product marks a
  type as ring-fenced yet; that setting comes with the ring-fence itself.
- **Record of processing activities.** The issues row names the contractors and
  the mail server among its recipients, and its purpose mentions work orders.
  A row the board has edited keeps its own text and is not refreshed.
