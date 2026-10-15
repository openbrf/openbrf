---
"@openbrf/web": patch
---

When the apartments at one address in Settings could not be read, the panel went on listing the apartments of the address picked before, with their removal buttons. Each list now stays with the address it was read for, so a failed read shows no apartments from another address. A failed re-read of the same address still keeps what was read before.
