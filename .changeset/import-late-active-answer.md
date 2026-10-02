---
"@openbrf/web": patch
---

Show the import screen's upload form only once the screen knows whether an
import is running.

On opening, the import screen asks the API for the import that is running or
last ran, and shows it. A board member who sent a file before that answer
arrived had their mapping step replaced by the earlier import. Worse, if that
import was still writing the register, they never saw it and could start a
second one. The upload form now appears only after the answer has arrived. If
the request fails, the form appears as before.
