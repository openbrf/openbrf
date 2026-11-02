---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

The administrator can withdraw one class of caller that a plugin's resident
routes serve besides residents, and consent to it again, on the plugins page
(ADR 0053). The plugin stays installed. A withdrawn class stops granting
access from the next request on, and consenting again lets it grant access from
the next request, with no restart and no new version. A person is still served
when another approved class they belong to, or a residency held today, grants
access: a board member who does not live here and is also the administrator
stays served when only the board is withdrawn. Each act is in the audit log with
the account that made it. The plugins page shows the board every class the
install approved, whether it is withdrawn, and who last consented to it and
withdrew it. A person with protected personal data is not named there, at the
time of the act or after: the page says only that a person whose name is
protected did it.

A withdrawn class stays withdrawn through a restart and through a consent to a
new version that still declares it. Only a consent again on the plugins page
brings it back. When a version that declares fewer classes loads, the install
forgets the classes it dropped, approved and withdrawn alike, so a later
version that declares one of them again is refused at load until the
administrator consents to it.
