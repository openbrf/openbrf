---
"@openbrf/api": patch
---

Retry the 48-hour breach reminder when the mail server is down, and send it
once.

A reminder that reached no board member because every send failed completed
anyway, so a mail outage at hour 48 cost the board its only warning before the
72-hour bound. It now fails and is tried again up to five times, starting after
five minutes and doubling the wait. Saving a breach with an unchanged discovery
time no longer queues a second reminder.
