---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A plugin now says in its manifest what its processing of personal data is for,
and a person can object to one plugin's processing (ADR 0035).

The manifest's new `processing` field gives the purpose, the legal basis (and
the legitimate interest relied on, where that is the basis), how long the data
is kept and whether it concerns members, residents or both, in Swedish and
English. The install consent screen shows it, and the install writes it into
the plugin's row in the record of processing activities in the association's
language. Before, that row had the plugin's name as its purpose and no
retention. The board's own edits to the row still win over a later version's
text. A plugin that handles no personal data and does not read the address book
no longer gets a row. The field is in version 2 of the catalog index, which an
instance now reads beside version 1. The package check, and version 2 of the
index, refuse a package that declares personal data without it, and one that
asks to read the address book but declares no personal data.

An objection recorded on a person's page can now name a plugin's processing
instead of the association's mailings. When the board grants it, the person is
left out of every read that plugin makes from the register until the objection
is closed, and the plugin is not told. An objection to the mailings is
unchanged and is a separate request.

`host.addressBook.residents()` takes `{ addressId }` to read one entrance. Each
resident carries `lastName` alone, and `nameInBuilding`, read from a new
publication-consent scope for a name on screens inside the building. The board
records that consent on the person's page like the others.

`host.audit.record` lets a plugin write what it did to the audit log, as
`PLUGIN_RECORDED`, with the person it acted for as the actor. The entry's
`detail` keys are letters and digits, and a field holding a personal identity
number is refused without the number in the error. The data subject
access report prints the entry in the plugin's own words, and prints which
processing an objection named and the new consent scope.
