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
the job tries it again a few seconds later, as it does after a lost database
connection. The reindex also takes the identity number lock for the index a
number leaves and the one it gets, as every other writer of a number does.
