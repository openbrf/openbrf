---
"@openbrf/web": patch
---

In the chat, a refusal on the list of rooms read again after a group was made is
now said as a refusal, without a retry, instead of as a failed read. A line typed
in the room that stayed open while the list could not be read is no longer
carried into the group a successful retry opens, and a retry that lands after
the reader has chosen another room no longer moves them to the new group.
