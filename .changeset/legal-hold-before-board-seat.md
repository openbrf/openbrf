---
"@openbrf/api": patch
---

When a person under a legal hold also holds a board seat that has not ended, a
granted erasure request that is still waiting now gives the legal hold as the
reason on the board's open requests, not the board seat. The person's data is
kept either way; only the reason shown changes, and it now follows the order in
which recording an erasure grant already checked them. A person who has only the
legal hold or only the board seat sees no change.
