---
"@openbrf/web": patch
"@openbrf/shared": patch
"@openbrf/api": patch
---

The data-subject request forms and the breach decision and notification forms no longer answer a refused field with "could not be saved just now": they name the field the server did not accept, and they no longer send a request without its date or ground, or a decision without its ground. The grounds are held to the lengths the server accepts. A breach that was closed or removed in the meantime, or a notification recorded before the decision, now says so instead of falling back to "could not be saved".
