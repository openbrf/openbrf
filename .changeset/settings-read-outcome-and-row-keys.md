---
"@openbrf/web": patch
---

End the loading line on the two settings panels whose first read can fail, and
key a resource row on an encoding of what is stored rather than a join.

**A read that could not be made stops saying it is reading.** The bookable
resources panel and the issue types panel each held the outcome of a read in a
flag beside the list, and a first read that failed left the list at nothing: so
the notice saying the catalogue could not be read and the line saying it was
being read sat on the screen together, and the line never cleared, because
nothing was left in flight to clear it. The outcome now travels on the read's own
record beside the list it answers for, and one comparison decides both whether
that record is the read the panel is on and whether it failed - so the two cannot
fall out of step. A read that is asked for again says it is reading rather than
wearing the failure of the read before it, and a refresh that did not land leaves
the rows the board is typing in where they are, because there is one catalogue
and the last answer about it is the best there is. The panels now have one reader
rather than two, so every answer is dropped once the panel is gone or a later
read has superseded it.

**A resource row re-seeds from what is stored.** The row is keyed on the stored
values so that a save re-seeds its fields with what is now stored rather than
leaving them showing what was typed. That key joined the values on a separator,
and two of them are free text a board types: a resource named "Tvattstugan|" with
nothing said about it produced the same key as one named "Tvattstugan" described
as "|", so a save that stored either of those left the row on the key it had and
the fields on the screen showing neither. The key is an encoding of the values
now, which no character in them can collide.
