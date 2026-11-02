---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

The administrator can withdraw one class of caller that a plugin's resident
routes serve besides residents, and consent to it again, on the plugins page
(ADR 0053). The plugin stays installed. Nobody in a withdrawn class is served
from their next request on, and consenting again serves the class from the next
request, with no restart and no new version. Each act is in the audit log with
the account that made it. The plugins page shows the board every class the
install approved, whether it is withdrawn, and who last consented to it and
withdrew it.

A withdrawn class stays withdrawn through a restart and through a consent to a
new version that still declares it. Only a consent again on the plugins page
brings it back. When a version that declares fewer classes loads, the install
forgets the classes it dropped, approved and withdrawn alike, so a later
version that declares one of them again is refused at load as
`resident-routes-widened` until the administrator consents.
