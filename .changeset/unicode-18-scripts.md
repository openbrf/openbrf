---
"@openbrf/api": patch
---

The board's check for a sender domain that mixes scripts now knows the three
scripts Unicode 18 adds (Jurchen, Proto-Cuneiform and Seal Script), so a domain
that mixes one of them with Latin letters is flagged like any other lookalike.
