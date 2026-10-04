---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Stop an import instead of entering a person twice. A row the import planned as
a new person is checked against the register again inside the transaction that
writes it. If somebody with the row's email address, personal identity number,
or name and apartment was added after the plan, the import stops without
writing that part of the file, and the screen asks the board to import the file
again so the preview shows the match.
