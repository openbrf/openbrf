---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Refuse an SMTP or board mailbox host that holds a line break or another control
character. No host name or address has one, and the host is written into the
log when the settings are saved, so a line break in it could add a line of its
own there. The SMTP card no longer warns about settings saved before TLS was
required: the instance now requires STARTTLS of a server that is not on the same
machine whatever the stored settings say, so the risk it described is gone.
