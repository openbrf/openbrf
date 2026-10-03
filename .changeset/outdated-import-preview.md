---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Ask for a fresh preview when another import has written to the register since.

Applying an import is now refused with `preview-outdated` (409) when another
import finished writing after this one was previewed. The preview was taken
against a register that has changed: its counts may no longer hold, and a row
it matched to one person can match two now. Such a row used to stop the import
on its first chunk with `ambiguous-rows-undecided`, and the session it left
FAILED could not be previewed again, so the file had to be uploaded again. The
refusal comes before anything is claimed, so the upload stays in the mapping
step and previewing it again makes it applicable. An import that stopped before
writing anything does not count.

The preview's timestamp is now taken before it reads the register rather than
after, so an import that finishes while a preview is being worked out counts as
finishing after it.

A finished import is kept for a lifetime after it finished before the daily
purge removes it, not a lifetime after it was uploaded. Without that, the purge
could remove the import that made another session's preview out of date while
that session was still valid, and the check would no longer see it.

The import screen takes the preview again on its own, says why in Swedish and
English, and asks again about every row that needs a decision.
