---
"@openbrf/api": patch
---

Leave no file behind when an upload cannot be written to the audit log. The file's
row and its audit entry are now written together, and the stored object is removed
if either fails.
