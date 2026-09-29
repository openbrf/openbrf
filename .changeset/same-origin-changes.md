---
"@openbrf/api": minor
---

Refuse a change sent with the session cookie from a page on another origin. A
POST, PUT, PATCH or DELETE whose `Origin` is not the instance's `APP_URL`, or
whose `Sec-Fetch-Site` names another site, answers 403 before the session is
read. A request carrying neither header, which a browser page cannot send, is
unaffected, as are reads.
