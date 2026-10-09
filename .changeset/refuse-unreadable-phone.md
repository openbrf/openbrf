---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Refuse a phone number the register cannot read when the board adds a person, as
an unreadable email address already is. A number with no digits was stored and
looked like a number on file while no search could match it. The add-person form
names the refusal. An email address already on file is not refused: a household
can share one address, and the sign-up approval already refuses to guess between
the people on it.
