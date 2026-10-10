---
"@openbrf/api": patch
---

Keep an import from entering a person a second time while the reindex at boot
rewrites personal identity numbers.

After an upgrade that changes how numbers are normalised, the reindex at boot
moves each person's number to the index the new rules compute. Until it has
reached a person, a lookup by their number misses them. An import applying in
that window could enter a row with that number as a new person, and the
reindex would then give the person it had missed the same number. The register
held two persons for one human being.

An import chunk that writes personal identity numbers now checks whether any
number is still waiting for the reindex. While one is, the chunk rolls back and
the apply is queued again for half a minute later. The wait does not spend the
retries meant for a lost database connection, so a long reindex no longer ends
the import as interrupted. An import that has waited an hour stops as
interrupted, and the log says it was waiting for the reindex.

The reindex also takes the identity number lock for the index a number leaves
and the one it gets, as every other writer of a number does. It waits up to
three minutes for that lock, longer than an import chunk holds it, and a run
that does not finish is queued again a minute later rather than left until the
next restart.
