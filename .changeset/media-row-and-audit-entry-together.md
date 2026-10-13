---
"@openbrf/api": patch
---

Write an uploaded file's row and the audit entry that records it in one
transaction. An entry that could not be written used to leave the row and the
stored file behind, outside the rollback of the caller that uploaded it; the
upload now fails as a whole and removes the stored file.
