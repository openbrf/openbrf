---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Ask for the password again when the mail server, the board mailbox's server or
the SMS gateway changes.

Leaving a password field empty keeps the one stored, which is what saving the
rest of a form should do. It also meant that a new host, port, SMS provider or
gateway address was saved beside the old credential, and the next message
presented that credential to whatever answered at the new address. A save that
moves the endpoint now has to carry the secret again, or clear it, and the
settings screen says so when it does not.
