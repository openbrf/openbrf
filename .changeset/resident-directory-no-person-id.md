---
"@openbrf/api": patch
"@openbrf/web": patch
---

Leave the person's id off the rows of the resident directory. A neighbour reads
who lives where, and the id was a handle on a person that nothing in their view
used. The row key is the residency's id, or for somebody with no apartment a
digest of the person's, so it identifies nobody. The board's rows still carry
the id, which is how the board opens a person.
