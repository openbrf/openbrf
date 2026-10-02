---
"@openbrf/web": patch
---

Wait to learn of a running import before the import screen takes a file.

On opening, the import screen asks the API for the import that is running or
last ran, and shows it. A board member who sent a file before that answer
arrived had their mapping step replaced by the earlier import. Worse, if that
import was still writing the register, they never saw it and could start a
second one. The screen now keeps the upload button disabled until the answer
has arrived. If the request fails, the button is enabled again.
