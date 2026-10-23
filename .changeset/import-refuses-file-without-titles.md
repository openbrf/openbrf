---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/plugin-sdk": patch
---

The import now refuses a member list saved without its row of column titles,
when the first row holds a personal identity number, an email address, a phone
number or a date. The import would otherwise have read that row as the titles:
it would show a member's details as column names and store them with the
upload. The upload is refused before any of the file is stored, and the board
is asked to add a row of column titles and upload the file again.

A file a plugin proposes is refused the same way, with the reason
`header-row-missing`, which `IMPORT_PROPOSAL_REFUSAL_REASONS` now lists.
