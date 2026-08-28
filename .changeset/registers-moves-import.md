---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the statutory register views, the move flows and the import.

The member register (EFL 5 kap. via BRL 9 kap.) and the apartment register
(BRL 9 kap.) render as two separate documents with two separate endpoints and
two separate screens. The member register extract carries name, postal address,
apartment linkage and the membership dates, and never a personal identity
number: it is public on request. The apartment register carries the apartment
designation, its holders, the initial share capital, the participation share,
lien notes with their dates of record and transfers with their agreement
references; it is confidential, open to the board and to each tenant-owner for
their own entry. Identity numbers arrive masked, and producing the full
statutory copy is a separate request whose audit entry names everyone it
disclosed and why it was asked for. The board's copy carries every holder's
number; a tenant-owner's own copy carries theirs alone, because an apartment
lists its co-holders and its previous holders too. Noting a lien and releasing
one are recorded in the audit log like every read of the register, and a note
that already carries a release date keeps it: that date is the statutory date
of record on a row nobody can delete. Both extracts print through a print
stylesheet rather than a PDF engine.

Move-in creates the residency, writes the member register entry when the person
takes over a tenant-ownership, records a transfer when there is one, and sends
the welcome email in the recipient's own language. Move-out sets the date,
computes and displays the purge date from the retention policy, records the
transfer, and closes the membership in the register when the person's last
tenant-ownership ends. A job on the move-out date sends the board a summary, and
that job is written by the same transaction as the register rows, so a move-out
that is recorded is a move-out the board will be reminded of. A message that
cannot be delivered is reported by residency and by the class of the failure,
never by address and never by what the failure was carrying.

Import reads a CSV file or an Excel workbook, guesses the column mapping from
the titles in either language, and shows what would happen - creates, updates,
rows with problems named one by one, and rows matching more than one person,
which block the import until somebody decides. Persons are matched by personal
identity number, then email, then apartment and exact name. An update fills in
what the register does not have and never overwrites what it does. A personal
identity number costs 43.8 ms to index by design, so writing the register is a
background job that walks the file in chunks rather than work done inside the
request: the screen shows the rows done against the rows the file holds, the
page can be closed while it runs, and an import interrupted by a restart carries
on from the chunk it reached rather than writing anything a second time. The
import that runs is the one that was previewed. Starting it claims the upload
with a conditional update so two applies of one upload cannot both queue it, and
each chunk claims its place in the file the same way, in the transaction that
writes it. Uploads are deleted once they expire, and a template is downloadable
in the reader's own language.
