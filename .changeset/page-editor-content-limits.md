---
"@openbrf/web": patch
---

The page editor now holds a heading, a picture's description and its caption to the lengths the server accepts, and stops offering new blocks once a page has the 200 the server allows. Before, a 301-character description was accepted in the form and the whole save was refused.
