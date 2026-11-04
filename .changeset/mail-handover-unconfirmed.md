---
"@openbrf/api": patch
"@openbrf/i18n": patch
---

A mail error no longer reads as "not sent" when the mail server may have taken
the message before the error. When a work order or an answer from the board's
shared mailbox fails, the mail drivers now say whether the error came before the
message reached the mail server (the server could not be reached, or it refused
the sign-in, the address or the message) or after it may have (a connection that
broke or went quiet once the message was on its way, a mail API that failed
after reading the request or never answered). Only the first is recorded as not
sent. The second is shown as unconfirmed, with advice to check with the
recipient before sending again, so the same job or answer is not sent twice.

Outside production, an answer from the board's shared mailbox sent with no mail
server set up is now recorded as not sent, as a work order already is, rather
than as sent. An answer whose correspondent's address cannot be read back is now
retried and then recorded as interrupted, not as refused by the mail server.
