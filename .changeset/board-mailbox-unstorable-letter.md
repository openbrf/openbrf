---
"@openbrf/api": patch
---

Harden the collection of the board's mailbox against letters it cannot store.

A collected letter's text no longer keeps control characters other than tabs
and line breaks, whether they arrived as bytes or, in an HTML letter, as
numeric character references. A letter the database still refuses is set
aside and recorded as read, and the collection carries on with the letters
behind it rather than stopping at it on every run. Only a refusal of the
data itself sets a letter aside: a failure of the database - out of reach,
restarting, out of connections or resources, a statement cancelled or timed
out, a lock or a write conflict - or an error that is not an answer from the
database at all is not recorded against the letter, which is tried again on
the next run.
