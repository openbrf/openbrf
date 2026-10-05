---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Record two changes in the audit log: editing an archive document
(`DOCUMENT_UPDATED`, with the fields that changed and the audience before and
after, never the title), and changing how long data is kept after a move-out
(`ASSOCIATION_RETENTION_RECORDED`, with the days before and after). A migration
adds the two actions, and a person's access report labels them.

Two edits of one document, or two changes of the retention period, arriving
together are ordered, so each entry names the value its own change replaced.
