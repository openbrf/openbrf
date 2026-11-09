---
"@openbrf/api": minor
"@openbrf/web": patch
"@openbrf/i18n": patch
---

The first work order mailed to a contractor now links the association's
privacy notice on its website, as GDPR art. 14(3)(b) asks, and a later one
does not. A contractor counts as told once the mail server has accepted a mail
that carried the link. After the board changes the contractor's name or email
address, the next work order carries the link again. A work order still queued
for the earlier name or address also carries it, even if a work order to the
new ones went out first.

A work order that must carry the link is never sent without it. While the
privacy notice is not on the website for anyone to read, a handler cannot
preview or send such a work order and is told to have the board publish the
notice first. A work order already queued when the notice was taken down is
recorded as not sent, and the handler writes it again once the notice is
published. Work orders to a contractor who has already been told are sent as
before.

The nightly issue purge now removes a contractor from the list ten years after
the last work order sent them, or ten years after they were added if none was.
Their name, trade, telephone number and email address leave the list on that
clock, whatever their work orders still hold. A work order sent them keeps the
name and address it was written to for as long as it keeps its own text: until
its text is erased ten years after its issue was closed, and longer while a
legal hold stands on the issue. Other work orders lose the name and address
when the contractor goes.

The record of processing activities' text for issues gives the legal basis for
the contractor list: the contract for a sole trader, and legitimate interest
for a firm's contact person. It also states the list's ten-year clock. The
contractor list's description says the same, in Swedish and English.
