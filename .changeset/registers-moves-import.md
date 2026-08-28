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
disclosed. Both extracts print through a print stylesheet rather than a PDF
engine.

Move-in creates the residency, writes the member register entry when the person
takes over a tenant-ownership, records a transfer when there is one, and sends
the welcome email in the recipient's own language. Move-out sets the date,
computes and displays the purge date from the retention policy, records the
transfer, and closes the membership in the register when the person's last
tenant-ownership ends. A job on the move-out date sends the board a summary.

Import reads a CSV file or an Excel workbook, guesses the column mapping from
the titles in either language, and shows what would happen - creates, updates,
rows with problems named one by one, and rows matching more than one person,
which block the import until somebody decides. Persons are matched by personal
identity number, then email, then apartment and exact name. An update fills in
what the register does not have and never overwrites what it does. A template
is downloadable in the reader's own language.
