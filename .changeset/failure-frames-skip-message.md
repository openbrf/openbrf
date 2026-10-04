---
"@openbrf/api": patch
---

Leave every line of an error's message out of the stack frames that are
logged, including a message line that begins with "at ", so an address in a
message is never logged as a frame and never read as evidence of which plugin
failed at boot. Only lines indented as a call frame are kept, so this holds even
when the message no longer matches the head of the stack.
