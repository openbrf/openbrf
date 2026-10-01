---
"@openbrf/web": patch
---

Keep the import's mapping step when the screen learns of an earlier import
after a file has been sent.

On opening, the import screen asks the API for the import that is running or
last ran, and shows it. A board member who sent a file before that answer
arrived had their mapping step replaced by the earlier import. The answer now
only switches the screen while nothing has been uploaded yet.
