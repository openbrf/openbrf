---
"@openbrf/api": patch
---

Accept a connected app's token only while the member's consent to that app
stands, so a token minted around a disconnect is refused. Disconnecting a
connection that does not exist answers 404 and writes no audit entry.

Name an app that registered itself by its metadata document by the host of its
client id, on the connected-app screens, in the audit log, in the record of
processing and in the access report, instead of "unknown host". One helper now
names a connected app's host everywhere.
