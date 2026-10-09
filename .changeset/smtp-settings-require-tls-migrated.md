---
"@openbrf/api": minor
---

Require TLS of the SMTP server a board saved before saving required it. The
upgrade's migration holds those settings to the rule a save applies: a server
that is not on the same machine has to upgrade through STARTTLS before the
instance signs in.

**Check your mail after upgrading.** A connection that starts in cleartext to a
server that offers no STARTTLS, which sent mail before the upgrade, sends none
after it: every send through it fails with the reason `mail-tls-unavailable`,
and nothing, the password included, is sent. Send a test message from the SMTP
card. If it fails that way, switch to implicit TLS (usually port 465) or a port
that offers STARTTLS (usually 587). Implicit TLS and a server on `localhost`,
`127.0.0.1` or `::1` are not affected.

Settings that do not require STARTTLS anyway, such as those a data-only restore
of an older backup brings back, are held to it all the same: the instance
requires STARTTLS of a server that is not on the same machine when it sends,
whatever the stored settings say.
