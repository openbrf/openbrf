---
"@openbrf/web": patch
---

Stop the page editor from deleting blocks it cannot edit.

The privacy notice screen adds a block with the controller's contact details
(`controllerContact`), which the privacy notice must show (GDPR art. 13(1)(a)).
The page editor did not know that block type. A save sends the whole page, and
the editor sent only the block types it knew, so saving the privacy notice after
any edit deleted the controller's contact details without telling anyone.

The editor now knows the controller-contact block and keeps it on save. It also
keeps any other block type it does not know, unchanged, instead of dropping it.
