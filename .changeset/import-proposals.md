---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": patch
"@openbrf/shared": minor
---

A plugin can now hand the board a member list to review, such as one emailed
to the association (ADR 0043). It asks for the new permission
`addressBook:proposeImport` and calls `host.imports.propose` with the file, CSV
or XLSX, and, when its source has one, who sent it. The core reads the file
exactly as it reads an upload and holds it as an import proposal. Nothing is
written to the register until a board member has previewed and applied it on
the import screen. A plugin cannot read the register through this permission,
and it is told only the receipt, why a file was refused, and where its own
proposals stand (`host.imports.status`). It can take one back with
`host.imports.withdraw`.

Proposals wait at the top of the import screen as "Proposed by" the plugin,
with the file name, the row count, when the file arrived and the sender as the
plugin reported it, and in the board's "To handle" queue on the overview. A
board member opens one at the mapping step, with the mapping saved for that
plugin's files when the column titles are the same, or rejects it. A plugin has
one proposal waiting at a time: a newer file supersedes the one before, and a
file holding the rows of the one waiting, or of the last one the board applied
from it, is refused as unchanged. A proposal nobody decides expires after 14
days. Decided proposals are listed below the waiting ones, and each record is
deleted 90 days after it was decided. The audit log records that a plugin
proposed a list, and that a board member rejected one, without the file name or
the sender.

Every import, uploaded or proposed, now deletes the rows of its file, its
preview and the board's decisions as soon as it has been applied or has
stopped, rather than keeping them until the upload expires.

A plugin that declares `addressBook:proposeImport` must declare the personal
data categories `name`, `apartment`, `residency`, `email`, `phone`,
`personalIdentityNumber` and `protected`, because the list it carries can hold
all of them. The last two are new to a plugin's declaration and are refused
without the permission. `protected` is also a category the association's record
of processing activities can now name. The permission cannot be combined with
`site:blocks` or with a device route. The install consent now asks whether a
plugin sends personal data outside the instance or receives it from outside.

The first release with this change is the minimum host release for a plugin
that proposes imports: an older host refuses the permission in the manifest.
