---
"@openbrf/web": patch
---

The issue report form let a resident write a longer place or description than the server stores, and the finished report was then refused with a generic error. The fields now stop at 200 and 4000 characters, the lengths the server accepts.
