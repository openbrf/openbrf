---
"@openbrf/api": patch
---

A news save and a publish of the same item at the same moment could each act on what the item was before the other one landed. A save could write a personal identity number into an item that had just been published, a publish could make readable a personal identity number a save had just written, and a save could rename an item whose address had just been mailed to the members. Both now lock the item's row and check it as it stands before writing.
