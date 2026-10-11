---
"@openbrf/api": patch
---

An Excel member list with formulas is no longer refused as too long because of
the calculation chain, or because of the values Excel keeps from another
workbook a formula refers to. The import never reads those parts, so they are
now left out instead of checked.
