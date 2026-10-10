---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Record who made six privileged writes in the audit log. Moving an issue between
statuses, entering a move-in or a move-out, switching a plugin on or off and
changing a plugin's settings wrote no entry, so the property manager, the board
or an administrator could do any of them without a trace. Each entry is written
in the transaction that makes the change and names the person who made it.
The settings entry names the fields and never the values, and the issue entry
leaves the reporter's words out. The access report prints the new actions in the
reader's language.
