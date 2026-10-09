---
"@openbrf/api": patch
---

Stop an import rather than write a row the board decided to skip, or to make a
new person, to the person it matches after the register changed.

An import of a long file is written in chunks, and the register can change
while it runs. When a row that waited for a decision no longer needs one by the
time its chunk is written, because a name was corrected or one of the people it
matched was removed, the import used to drop the board's decision and write the
row to the one person it then matched: a row the board chose to skip, or to
make a new person, became an update of that person, with a residency and
possibly a member register entry, which cannot be removed. The import now
stops at that chunk, records it as "register-changed-during-apply" and writes
nothing from that chunk. The screen then says the register changed while the
import ran, either because a row now matches somebody added or changed during
the import or because a choice made for a row no longer fits the register, and
asks the board to import the rest as a new file: the session cannot be
previewed again, and the new file's preview shows what each row matches at
that time. This differs from a request that arrives with decisions the preview does not need,
which is still refused at once as "preview-outdated" ("Your choices change what
other rows match. Preview the import again.") before anything is written.
