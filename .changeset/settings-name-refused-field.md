---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

When the server refused a settings form because a field did not pass its check, such as a malformed organisation number or postal code, an email address the browser accepted, or an `ftp://` SMS gateway address, the screen said the change "could not be saved just now, try again". Trying again could never work, and no field was named. The settings panels now name the field that was not accepted, and the forms check the organisation number, postal code, email addresses, gateway address and lengths before sending.

The first-boot setup form reported a refused email address as a password that was too short. It now says the email address could not be read.
