---
"@openbrf/api": minor
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Harden the outbound connections to the SMTP server and the SMS gateway an
administrator enters in the settings. A host that is, or resolves to, a
loopback, private, link-local or other special-use address is refused when the
settings are saved, with a message in English and Swedish, and again at each
send. The connection is made to the address that was checked, and the host's
name is still what TLS checks the certificate against. The SMS gateway is now
reached through Node's own HTTP client rather than `fetch`, and an address
carrying a user name or password is refused.

A relay or a gateway on a network the operator controls, such as the
association's own LAN, needs the new `OPENBRF_ALLOW_PRIVATE_HOSTS=true`, which
is off by default and mapped in `docker-compose.prod.yml`. Settings saved by an
earlier version that name a private host stop sending until it is set. Servers
set in the environment are not checked. The address rule is shared with the
connected-app metadata fetch, whose behaviour does not change.
