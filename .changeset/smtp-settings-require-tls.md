---
"@openbrf/api": minor
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Require TLS of the SMTP server a board enters in the settings. Once the
settings are saved, a connection that starts in cleartext has to upgrade
through STARTTLS before the instance signs in, unless the server is on the
same machine, so a server that does not offer it, or an attacker on the path
who strips the offer, gets no password in the clear. A test message that fails because the
server set up no encrypted connection says so, in English and Swedish, rather
than pointing at the password.
