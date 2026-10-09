---
"@openbrf/api": patch
---

Stop resending the breach reminder to board members it already reached. A
discovery time corrected from A to B and back to A queued two reminders that
both fired, and a send that reached some of the board and failed for the rest
was retried for all of them. The reminder now records, under the breach's lock,
who it reached for each discovery time (a time corrected from A to B and back
to A finds A's receipts still there), mails each member under that lock, retries
only the members not reached, stops when the board answers meanwhile, and logs
once when the last retry gives up. Delivery is at least once: if recording a
member fails after their mail has left, the retry mails them again.
