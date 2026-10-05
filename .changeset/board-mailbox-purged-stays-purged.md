---
"@openbrf/api": patch
---

Keep a purged board mailbox letter erased.

The collector never deletes mail from the board's mailbox, and it decides what
it already holds from the POP3 identifiers it remembers. The retention purge
erased a thread and its messages, and with them the only record of those
identifiers, so a letter still in the mailbox could be collected again after
its thread was purged.

The purge now records the identifier of every letter it erases, in the same
transaction, in the ledger of messages the collector will not store. The
collector also leaves alone a letter that is already past the retention window
the first time it reads it, and records it there too, so the letter is not
fetched again.
