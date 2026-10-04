---
"@openbrf/api": minor
---

Serve an internal file only to holders of the capability it names.

Every file held INTERNAL now names a capability, which a database CHECK
enforces and the upload refuses to skip: attachments collected by the board
mailbox are read with `boardMailbox:handle`, and the photos on an issue report
with `issues:handle`, while the resident who reported the issue still sees its
photos. A migration gives files already stored the capability of what they
belong to, and each read by capability is written to the audit log.

`media_file.visibility` has no default any more: every write states it.
