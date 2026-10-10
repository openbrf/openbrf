---
"@openbrf/web": patch
---

A negative amount was printed as it was computed, such as "-1234.56", among
amounts formatted like "1 234,56". This showed on the fee screen when the
participation shares add up to more than one and leave a negative remainder.
Negative amounts are now grouped and separated like the others, with the
locale's own minus sign.
