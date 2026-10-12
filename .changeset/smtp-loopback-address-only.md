---
"@openbrf/api": minor
"@openbrf/i18n": minor
---

Exempt an SMTP server from STARTTLS only at a loopback address, not by the name
`localhost`.

A server named `localhost` was signed in to without TLS when it offered none.
The SMTP driver asks DNS what a name is before it reads the hosts file, and Node
asks the network about `localhost` like any other name, so whoever could answer
the instance's DNS could have received the sign-in in the clear. Only
`127.0.0.1` and `::1` are exempt now, for the relay the environment sets and for
the server the board enters, including settings saved before.

An instance that sends through a server named `localhost` which offers no
STARTTLS stops sending mail on this upgrade: every send fails with the reason
`mail-tls-unavailable` and nothing, the password included, leaves the instance.
Before upgrading, write that server as `127.0.0.1` or `::1` - in
`OPENBRF_SMTP_HOST` for the relay, on the SMTP card for a server the board
entered - or have it offer TLS, through STARTTLS or implicit TLS on port 465
(`OPENBRF_SMTP_SECURE=true` for the relay). Send a test message from the SMTP
card afterwards.

The SMTP and board mailbox hosts are also refused when they hold a C1 control
character or a Unicode line or paragraph separator, as they already were with
any other control character. The hint under the SMTP card's TLS box no longer
says the rule waits for a save.
