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
long as the mailbox keeps it. Such a letter is tried again every six hours, so
the letters an outage longer than an hour set aside are collected once the
instance has recovered.

The board's mailbox screen now lists the letters the collection set aside, with
why, the date the letter carried and when it is tried again, so a board member
can find them in a mail client. They are still in the mailbox. A letter deleted
from the mailbox leaves the list at the next collection, and so does one that
was stored after all, such as one two overlapping collections handled at once.
A letter the purge erased, or one already past the retention window when it
was read, is not listed: neither is the board's to go and read.

A letter that was not stored no longer leaves its attachments behind in
storage. A file is kept when a row names it, so a letter whose write landed
although the database's answer was lost keeps its attachments. The audit log no
longer records the file name of an attachment the collection stores or removes. An attachment that storage would not take no longer drops the file
from a letter that is stored for good: the letter is tried again with it.

The collection reads no more than four times the stored length of a letter's
body, decodes no more of its bytes than that needs, and still says when a letter
was cut. A letter written as alternatives nested inside each other is read in
time proportional to its parts: each alternative used to be read twice when none
of them was plain text, so every level of nesting doubled the work. A sender address carrying a control
character is refused. Characters that reorder text are removed from attachment
names, so a name cannot show as a different file type from the one it has.
