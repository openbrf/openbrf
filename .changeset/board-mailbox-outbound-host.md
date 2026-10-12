---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Harden the outbound connection to the board mailbox's POP3 server, which an
administrator enters in the settings, the way the SMTP server and the SMS
gateway already are. A host that is, or resolves to, a loopback, private,
link-local or other special-use address is refused when the settings are saved
and again at each collection, with a message in English and Swedish on the
settings screen and on the board's mailbox screen. The connection is made to
the address that was checked, and the host's name is still what TLS checks the
certificate against. Finding the host's address now counts against the
connection's own ten-second limit.

A mailbox on a network the operator controls needs
`OPENBRF_ALLOW_PRIVATE_HOSTS=true`. A mailbox saved by an earlier version that
names a private host is no longer collected until it is set, or a public server
is entered.
