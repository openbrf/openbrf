---
"@openbrf/web": patch
---

When a page of the board's motion queue could not be read during the re-read
after handling a motion, the whole queue was replaced by the screen's load
failure. The screen now keeps the pages it had read before the failure, says
beside the "more" control that a page could not be read, and the control tries
that page again.
