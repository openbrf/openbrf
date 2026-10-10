---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Ask for a fresh preview when another import has written to the register since.

Applying an import is now refused with `preview-outdated` (400) when another
import wrote to the register after this one was previewed. The preview was taken
against a register that has changed: its counts may no longer hold, and a row
it matched to one person can match two now. Such a row used to stop the import
on its first chunk with `ambiguous-rows-undecided`, and the session it left
FAILED could not be previewed again, so the file had to be uploaded again. The
refusal comes before anything is claimed, so the upload stays in the mapping
step and previewing it again makes it applicable. An import that wrote nothing,
because it stopped first or because every row was skipped or in error, does not
count.

What tells the two apart is a count of import chunks that wrote, kept in a new
single-row table, `import_revision`. A chunk advances it in the same
transaction as its writes, and a preview records it on the session
(`previewedRevision`) before it reads the register. It does not depend on
clocks, or on the other session still being there after the daily purge. A
session previewed before this migration has no count recorded and is previewed
again before it applies.

The import screen already takes the preview again when an apply is refused as
outdated; its notice now names another import as a possible cause, in Swedish
and English.
