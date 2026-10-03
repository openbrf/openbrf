---
"@openbrf/api": patch
---

Accept a report from the website's issue form when its optional fields are
left blank.

A browser sends every field of a form, and one left untouched arrives as an
empty value. The issue report form read an empty email address as an address
that is not one and refused the whole report, so a report from somebody who
left no address could not be sent from any real browser. An optional field of
the website's forms that is blank, or only spaces, is now read as not given at
all. An address that is given is still checked, and a report with one that is
not an address is still refused.
