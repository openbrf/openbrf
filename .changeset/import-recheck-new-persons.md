---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Stop an import instead of entering a person twice. A row that writes a new
person - planned as one, decided as one by the board, or giving a person that
an earlier row creates an email address or a residency - is checked against the
register again inside the transaction that writes it. If somebody with the
row's email address, personal identity number, or name and apartment was added,
moved in or given those details after the plan, the import stops without
writing that part of the file, and the screen asks the board to import the rest
as a new file so the preview shows the match. A row the board answered is also
checked, chunk by chunk, against the persons the preview showed for it, so
somebody added while a long import runs stops it rather than being passed over.
Matching a row to a person on its apartment now counts a move-out dated today
as having happened, on the association's calendar, as the board's screens do.
