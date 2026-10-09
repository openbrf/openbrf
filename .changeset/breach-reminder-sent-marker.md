---
"@openbrf/api": patch
---

Send the breach reminder once per board member and discovery time. A discovery
time corrected from A to B and back to A queued two reminders that both fired,
and a send that reached some of the board and failed for the rest was retried
for all of them. The reminder now records, under the breach's lock, who it
reached for each discovery time (a time corrected from A to B and back to A
finds A's receipts still there), mails each member under that lock, retries
only the members not reached, stops when the board answers meanwhile, and logs
once when the last retry gives up.
