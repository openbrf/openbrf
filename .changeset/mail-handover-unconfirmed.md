---
"@openbrf/api": patch
"@openbrf/i18n": patch
---

A mail error no longer reads as "not sent" when the mail server may have taken
the message before the error. When a work order or an answer from the board
mailbox fails, the mail drivers now say whether the error came before the
message reached the mail server (the server could not be reached, or its
certificate was not accepted, or it refused the sign-in, the address or the
message) or after it may have (a connection that broke or went quiet once the
message was on its way, a mail API that failed after reading the request or
never answered). Only the first is recorded as not sent. The second is shown
as unconfirmed, with advice to check with the recipient before sending again,
so the same job or answer is not sent twice. An error raised before a mail
driver is called (the settings or the template could not be read, or the
stored mail password could not be decrypted) is recorded as not sent, since
nothing was composed or sent.

Outside production, an answer from the board mailbox sent with no mail
server set up is now recorded as not sent, as a work order already is, rather
than as sent. An answer whose correspondent's address cannot be read back is now
retried and then recorded as interrupted, not as refused by the mail server.
A repeated or redelivered job for an answer that is already sent or failed no
longer decrypts the correspondent's address before it is skipped.

A work order or an answer from the board mailbox that failed with the earlier
"not sent" code before this change is recorded as unconfirmed by a migration,
since nothing then told whether the mail server had taken it. A mail server
that refuses the connection in its greeting is recorded as not sent. The two
messages for a mail error before the handover now also name a message that
could not be prepared, and the two for an unconfirmed one no longer say when
the sending stopped.
