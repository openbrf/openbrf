---
"@openbrf/api": patch
---

Putting somebody into a group twice at the same moment, when that group is
their twentieth, now answers both presses with the member list. Before, the
second press answered `too-many-groups` even though the first had already put
them in. The limit of twenty groups per person still holds for two presses
putting one person into two different groups.
