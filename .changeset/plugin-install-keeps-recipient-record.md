---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

A plugin install no longer changes a recipient the art. 28 record already
classifies.

The consent step asks where a plugin sends personal data only when the record
has nothing for it, but the API recorded any answer an install carried. A
consent screen opened before somebody classified the plugin, or a direct caller
of the API, could therefore replace an agreement the board had recorded as in
place with one being made, holding only the permission to install plugins and
not the one that manages the data protection record.

An install that answers for a plugin the record already classifies is now
refused with `recipient-already-recorded` (409) before anything is written, and
the consent screen says the record changed since it was opened and that the
answer is changed on the data protection screen. An install that sends no
answer goes ahead and leaves the record as it is. The art. 28 write also keeps
a classification that lands between that check and the install's own write,
and serialises writers per recipient, so two concurrent classifications can no
longer leave two open rows for one recipient.
