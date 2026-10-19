---
"@openbrf/api": minor
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Prepare reports to Lantmäteriet's cooperative housing register
(bostadsrättsregistret) for sending, up to the point where they would go out.
ADR 0029 records the design.

Each grant, transfer, termination and transfer reversal report can now be
assembled from the register and checked against a documented content schema,
and sent through one port to Lantmäteriet. Lantmäteriet has not published the
technical interface yet, so every instance is bound to a transmission that
refuses. The board keeps recording reports it made by hand, exactly as before.

When an adapter exists, a report is refused if it could not be complete. The
disclosure of the holder's personal identity number is written to the audit log
before the report leaves. A duty counts as discharged only when Lantmäteriet
gives a receipt, and on Lantmäteriet's own date. A rejection or an unknown
outcome leaves the duty owed. The data subject access report labels the two new
audit entries.

For API clients: `POST /api/register-reports/transmissions`
(`{ "obligationId": "..." }`) answers `409 transmission-not-available` until
an adapter is bound.
