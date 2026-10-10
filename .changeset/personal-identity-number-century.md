---
"@openbrf/shared": patch
---

A personal identity number written with its century is refused when the
century is not 18, 19 or 20, or when the birth date lies in the future. The
person form and the import refuse it as not valid. A twelve-digit invoice or
OCR reference whose last ten digits happen to form a valid number is no longer
reported as a personal identity number, so it no longer stops the text it is in
from being published.

This is a check of what is entered. A number already stored keeps its index,
and is found as before.
