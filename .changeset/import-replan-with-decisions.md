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
refuses before anything is written if a further row needs a decision, or if a
row the preview asked about no longer does. The import screen then previews
the file again with the decisions made so far, keeps them, and shows the rows
that now need one.
