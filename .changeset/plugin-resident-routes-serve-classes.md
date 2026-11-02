---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A plugin's resident routes can serve people who do not live in the house, and
its view can be offered to every account (ADR 0053).

The guard on a resident route now checks, in one query and before any of the
plugin's code runs, the three refusals first (protected personal data, a
restriction, an objection to the plugin's processing) and then whether the
person holds a residency today or is in a class the plugin declares in
`nonResidentCallers` and the install approved. The host decides each class from
its own records, never from the plugin's. A former resident is in no class,
whatever seat or role they keep. Everybody refused gets the same 403 with
reason `resident-route-not-listed` and the same wording as before. The
navigation offers such a plugin's view on the same terms, without the three
refusals, or to every signed-in account when the view declares
`offeredTo: "signedIn"`.

The install records the classes the administrator approved with the consent
screen, and its audit entry names them with the account that consented. A
version that declares a class outside them is refused at load as
`resident-routes-widened`, which the findings panel names in Swedish and
English. The administrator consents again by installing the version with the
classes it declares. An install made before classes were recorded approved
none, so it serves the listed residents alone. The `pluginAccess` class serves
a person the board has given access to that plugin.
