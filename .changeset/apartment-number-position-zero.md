---
"@openbrf/shared": patch
"@openbrf/api": patch
---

An apartment number ending in "00", such as "1000", no longer has a floor read out of it. No apartment on a landing is number zero, so the number does not follow the Lantmäteriet convention, and it is now stored with no floor instead of being listed under the entrance floor. The correction applies to apartments added from now on: a row written earlier keeps the floor it was stored with, and the board can remove an unused one and add it again to have it recorded without one.
