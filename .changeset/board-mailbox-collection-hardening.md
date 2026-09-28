---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Harden the collection of the board's mailbox further.

A letter is set aside only when the database refused its values. Every other
failure to store it - a server that is read-only after a failover, a deploy
ahead of its migration, an internal error, storage that did not answer - is
tried again on the next run. A letter that fails on every run for an hour and
at least twelve times is then set aside, so it is not retried unseen for as
long as the mailbox keeps it.

The board's mailbox screen now lists the letters the collection set aside, with
why and the date the letter carried, so a board member can find them in a mail
client. They are still in the mailbox.

A letter that was not stored no longer leaves its attachments behind in
storage. An attachment that storage would not take no longer drops the file
from a letter that is stored for good: the letter is tried again with it.

The collection reads no more than four times the stored length of a letter's
body, and still says when a letter was cut. A sender address carrying a control
character is refused. Characters that reorder text are removed from attachment
names, so a name cannot show as a different file type from the one it has.
