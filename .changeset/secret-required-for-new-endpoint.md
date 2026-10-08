---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Ask for the password again when the mail server, the board mailbox's server or
the SMS gateway changes, or when the encrypted connection to one is turned off.

Leaving a password field empty keeps the one stored, which is what saving the
rest of a form should do. It also meant that a new host, port, SMS provider or
gateway address was saved beside the old credential, and the next message
presented that credential to whatever answered at the new address. Turning off
the encrypted connection to the same host and port did the same in clear text.
A save that moves the endpoint now has to carry the secret again, or clear it,
and the settings screen says so when it does not.

When another save changes the server or the stored secret while this one runs,
the screen says that instead, with a message of its own, since this save may
have changed nothing about the server.
