---
"@openbrf/api": patch
---

Collect a board mailbox letter made of millions of multipart parts without
running the API out of memory.

A multipart letter is split at each delimiter line, and the reader kept an
object of about a kilobyte for every part. A delimiter and a line break are
four bytes, so a letter inside the size limit the collector will fetch could
hold more than two million parts and grow the API's heap by gigabytes. Anybody
could send that letter to the board's published address. On a host with a
memory limit it could end the process, and since nothing is deleted from the
mailbox, end it again on every collection.

One letter may now hold 1,000 parts, at every depth together. A letter written
in text and HTML with files attached is a handful, and one with a hundred
pictures is far below the limit. A multipart whose parts would take the letter
past it is not split. It is shown as its source text, as a multipart nested
deeper than the reader walks already is, so the board sees that this is not a
letter as a mail client writes one, instead of a letter with part of it missing.
