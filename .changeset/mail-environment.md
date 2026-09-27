---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Let whoever runs an instance set its mail in the environment, either an SMTP
server or an HTTP mail API that takes a message as JSON with a key. Mail set
that way is used for every message the instance sends, from an address that
need not be on the association's own domain, under the association's name, and
with replies directed to the association; the settings screen and the setup
wizard show which service sends it and from which address, and no longer offer
to change it. Answers from the board mailbox keep their threads when the mail
service assigns its own message identifiers. Settings a board entered earlier
are kept and apply again if the environment stops setting the mail. The record
of processing activities and the processor register name the service mail
actually goes through.
