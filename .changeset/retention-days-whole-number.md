---
"@openbrf/web": patch
---

The retention window in Settings is read as the whole number typed. "45.9" is now refused instead of being saved as 45, and "30e1" is read as the 300 it means instead of 30. This number is how long the nightly purge waits after a move-out.
