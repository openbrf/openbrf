---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Tell the board why the import screen refused a file or a mapping.

A member list over the size limit was answered `invalid-body` by the upload's
request schema before the service could refuse it as `file-too-large`, so the
screen said only that the import did not work just now. The upload is now
refused as `file-too-large`, and the screen names the limit.

A mapping the API refuses now carries the problems it found, as codes, in a
`problems` field next to `mapping-invalid`, and the screen lists a sentence for
each of them under the general message instead of dropping them. The catalogs
gain the two problems they had no sentence for: a default role or move-in date
chosen while the file has the column.
