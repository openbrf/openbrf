---
"@openbrf/api": patch
---

Stop three ways a letter to the board mailbox could be left uncollected without
the board seeing it.

A letter's date is now held to when the mailbox received it, as its mailbox
provider's Received header records. A letter whose own date lies before the
retention window - from a device whose clock is years behind, or from somebody
who set it so - was set aside as past retention, and the board's screen does
not list those. It is now collected and dated by its arrival. A letter dated
more than a day away from its arrival is dated by its arrival in either
direction, so old mail in a mailbox is still left where it is when it is first
collected, whatever date it claims. A letter with no Received header keeps its
own date as before.

A letter is no longer taken for a copy of the board's own answer just because
it carries the answer's Message-ID. That identifier reaches the correspondent
with the answer, so anybody the board had answered could write to it again
under the identifier and the letter was never stored. A letter is now the
board's own answer only when its subject and every form of its text - the
plain text and the HTML alike - are the answer as this instance renders it,
and it carries no file and no other part. A copy that a mailing list or a mail
service has changed is collected as a letter, so the board may see its own
answer again; it no longer misses somebody else's letter. A copy of an answer
too long for the collector to read whole is still recognised by as much of it
as was read.

Further copies of one answer are no longer fetched on every collection. The
first copy is held under the answer, as before; each further one, which a
mailbox that files sent mail or a board that copies its own address can leave,
is now recorded as read. Before, enough of them filled every collection, and
the letters behind them were not collected.
