---
"@openbrf/api": patch
---

Keep the data of a person under a restriction of processing (GDPR art. 18)
out of every nightly purge.

The charge, fee, key order, sublet application and board mailbox purges
exempted people under a legal hold but not people under a restriction, so a
restricted person's rows were erased once their retention window ran out -
the one thing art. 18(2) says the association must not do. Each of them now
asks the question every other purge already asks: a legal hold or a standing
restriction keeps the rows, and lifting the restriction lets the next run
erase them.

A restriction granted while a purge is running is honoured too. The purge
reads it again after taking the person's legal hold lock, and granting a
restriction now also takes the registry lock the board mailbox purge waits on,
so the grant and the purge can no longer pass each other.
