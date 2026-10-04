---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Check the board's decisions on an import before it starts writing.

A decision on an ambiguous row writes something the preview could not know:
the person chosen for the row gets its email address, and a new person gets
the row's details. A later row that contradicted that person used to be found
only while the import ran, and the import then stopped with part of the file
already in the register.

Starting an import now plans the whole file again with the decisions, and
refuses before anything is written if a further row needs a decision, or if
any row would be written differently from the preview: a row the preview asked
about that no longer needs a decision or now matches other people, or a row
shown as an update that would now create a person. That holds when every
decision is to skip a row too, since skipping can undo what the preview was
planned with. A decision for a row that needs none is refused the same way,
and a decision must name a row by its number, at most one per row a file can
hold. The import screen then previews the file again with the decisions made
so far, keeps those that still apply, and shows the rows that now need one.

A row the board decides never adds a personal identity number to a person
already in the register, even when the register changes while the import
runs.

An import previewed again elsewhere while it was being started is refused
rather than started with the other preview's mapping, and the screen says so
instead of previewing over the other preview. An import started while another
one is running is refused as such before its decisions are checked.

The preview also names the person a row is folded into when an earlier row of
the file creates them.
