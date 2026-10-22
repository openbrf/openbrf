---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

The participation share and initial share capital form on the apartment
register can no longer undo a newer correction. The form now sends only the
apartments the board member changed, each with the two figures as the form read
them when it opened. If another board member has saved figures for one of them
since, the whole save is refused and nothing in it is written. The register is
read again, and the form says so and keeps what was typed until it is cancelled;
opening it again then starts from the current figures. If the register cannot be
read again, the form says to reload the page instead. Before this the form sent every apartment's figures
on every save, so a board member who had opened it before a colleague saved put
the colleague's figures back, and the audit log recorded that as an ordinary
correction.

`POST /api/apartment-register/apartment-shares` now requires `expected` on every
row, the participation share and initial share capital the caller read, and
answers `409` with the reason `apartment-shares-changed` when the apartment no
longer reads them. A row that already reads what it submits is skipped as
before, whatever it expected.

The register now writes a participation share in plain decimal notation, so a
very small share such as 0.00000001 reaches the form as written and not as
`1e-8`. Before this a form that read such a share could neither correct nor
clear it: the share it sent back as the figure it had read was refused as not
a number.
