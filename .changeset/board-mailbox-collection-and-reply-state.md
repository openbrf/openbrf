---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Fix several ways the board mailbox could lose a letter, block the mailbox or
show a thread in the wrong state.

- A letter the mailbox sends more of than the board mailbox fetches, in bytes
  or in time, though its listing said it was small enough, is recorded as
  read and left in the mailbox. The run ends there, and the next run collects
  the letters behind it, rather than every run stopping at the same letter.
- A MIME part with no headers keeps its first paragraph. It was read as the
  part's headers, so a one-paragraph letter arrived empty.
- A mailbox that fails after sign-in, while listing its letters, is reported
  as unreachable rather than as a server error. A mailbox's listing may now be
  up to 16 MiB, so one holding tens of thousands of letters is collected rather
  than refused on every run.
- A reply whose sending stopped after it was claimed no longer reads as on its
  way for good. The queue retries it and then gives up, and the thread says
  that it is not known whether the answer went out, rather than that it did
  not. The same applies when the answer was handed over but could not be
  recorded as sent.
- Reopening a closed thread sets its status from the newest message on it.
  A follow-up nobody has answered goes back to whoever had the thread, or to
  every seat, rather than to answered. Reopening a thread that is not closed
  changes nothing.
