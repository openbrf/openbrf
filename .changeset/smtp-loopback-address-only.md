---
"@openbrf/api": patch
"@openbrf/i18n": patch
---

Exempt an SMTP server from STARTTLS only at a loopback address, not by the name
`localhost`.

A server named `localhost` was signed in to without TLS when it offered none.
The SMTP driver asks DNS what a name is before it reads the hosts file, and Node
asks the network about `localhost` like any other name, so whoever could answer
the instance's DNS could have received the sign-in in the clear. Only
`127.0.0.1` and `::1` are exempt now, for the relay the environment sets and for
the server the board enters, including settings saved before. A server on the
same machine that offers no STARTTLS is written as one of those addresses.

The SMTP and board mailbox hosts are also refused when they hold a C1 control
character or a Unicode line or paragraph separator, as they already were with
any other control character. The hint under the SMTP card's TLS box no longer
says the rule waits for a save.
