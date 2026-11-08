---
"@openbrf/i18n": patch
---

The plugins page now says that a withdrawn class of caller stops granting
access from the next request on, instead of saying that nobody in it is served
(ADR 0053). A person is still served when another class the install still
approves, or a residency held today, grants access: a board member who does
not live here and is also the administrator stays served when only the board
is withdrawn. Consenting again lets the class grant access from the next
request. The behaviour is unchanged: this corrects the 0.9.0 release note,
which said that nobody in a withdrawn class is served.
