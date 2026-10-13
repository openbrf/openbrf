---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Tighten the outbound-connection hardening. The address rule now also refuses the
IPv4-translated IPv6 range (`::ffff:0:0:0/96`) and the deprecated site-local
range (`fec0::/10`), and saving the SMS gateway address with a user name or
password is refused in the settings service as well as at the route, so such a
credential never reaches the stored column.
The SMS settings screen explains that refusal in the board's language.
