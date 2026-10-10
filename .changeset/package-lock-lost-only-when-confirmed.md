---
"@openbrf/api": patch
---

A plugin or theme change answers `package-lock-lost` only when its database
session is known to have ended.

When the wait for a plugin or theme id's lock failed with an error that does
not say whether the session ended, the session was asked a question to find
out, and any trouble with that question was taken for a lost session. A
session that was only slow to answer, a question that was cancelled, or an
answer that could not be read turned a failure the change could recover from
into a 503 with the reason `package-lock-lost`. Such a change now fails with
the error its wait met. A session that is confirmed gone, because the
connection dropped or the server ended it, is still answered 503 with the
reason `package-lock-lost`.
