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
  a work order. A contractor switched off is no longer offered and stays named
  on the work orders sent them. Removing a contractor, which the board confirms
  with a second press, also erases their name and address from those work
  orders, which stay on the issues. Every handler, the property manager
  included, chooses from the list; only those who configure the issue types
  change it, and each change is recorded in the audit log without the details
  themselves.
- **Writing and previewing.** On an issue, a handler chooses a contractor,
  writes what is to be done and where, and previews the mail as the contractor
  will receive it before sending. Changing the text or the contractor drops the
  preview, and the server sends only what was previewed: if the contractor's
  name or address changed after the preview, or the preview is over half an
  hour old, the handler is asked to preview again. The same work order sent
  twice within half an hour is refused, and one person may send twenty work
  orders an hour. An issue that is closed is offered no work order until it
  is reopened. The preview says when this instance has no mail server set
  up.
- **What the mail carries.** The handler's text and nothing else from the
  issue: never the report, the place the reporter wrote, the reporter, the
  photographs or a link into the application. A text holding a personal
  identity number is refused. When the reporter has protected personal data,
  the form warns the handler to keep their name and home out of it.
- **The record.** Each work order is stored on the issue before it is mailed,
  with whom it went to, when, what it said and who sent it, so the association
  can answer who received a person's data (GDPR art. 15(1)(c) and 19). The
  issue's handlers read it, with whether the mail went out and, if not, why;
  the screen follows a work order on its way until it is sent or fails, and a
  sending that may have gone out is shown as unconfirmed, not as not sent.
  Outside production, a work order sent with no mail server set up is recorded
  as not sent.
  A work order whose contractor was removed, or whose text was erased, before
  its sending began is not mailed and is recorded as not sent; one removed
  after that cannot be called back.
  The timeline shows each work order with how its mail stands - on its way,
  sent, not sent or unconfirmed - and an issue left open on the screen shows
  the mail going out without being reopened. The audit log records that it was queued,
  with the length of the text and none of its words. A reporter's data
  subject access report lists the work orders sent about their issues: to
  whom, when, and whether the mail went out, saying "not sent" only for a
  failure known not to have left the instance. The text of a work order is erased
  ten years after its issue was closed, when a claim about the work it ordered
  becomes time-barred; when it was sent stays, and whom it went to stays while
  the contractor is on the list. A report from the public form still loses
  its reporter's name and email address a year after it is closed, but while
  the text of a work order about it stands, the address is kept in a coded
  form that cannot be read back, and goes when the last text is erased: a
  legal hold or a restriction of processing placed later on the person who
  wrote in still keeps that text. In the same way, an issue reported by
  somebody in the register keeps its link to them while the text of a work
  order about it stands, and the purge of that person's data detaches it once
  the text is erased. The work order mail is written in the
  association's default language.
- **Ring-fenced types.** The board ring-fences an issue type in the settings,
  and each change is recorded in the audit log. A work order on an issue whose
  type is ring-fenced is refused in the service, its preview included. One
  written before its type was ring-fenced and still waiting to be sent is not
  mailed, and is recorded as not sent; one already on its way cannot be called
  back.
- **Record of processing activities.** The issues row names the contractors and
  the mail server among its recipients, and its purpose mentions work orders.
  A row the board has edited keeps its own text and is not refreshed.
