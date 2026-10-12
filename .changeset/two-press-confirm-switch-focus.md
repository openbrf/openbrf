---
"@openbrf/web": patch
---

Asking to disconnect an app while the question was already open on a later row left the keyboard focus on that later row's button, not on the new question. Focus now goes back to the button that asked only when the question is answered "Behåll".
