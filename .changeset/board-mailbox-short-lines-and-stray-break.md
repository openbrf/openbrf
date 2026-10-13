---
"@openbrf/api": patch
---

Collect a board mailbox letter made of millions of short lines without running
the API out of memory, and read the headers of a letter that arrives behind a
stray line break.

The POP3 client kept every line of a response as an object of its own, while its
size limit counted only bytes. A blank line is two bytes, so a letter of nothing
else, inside the 10 MiB limit, grew the API's heap by more than 600 MB. Anybody
could send that letter to the board's published address. On a host with a memory
limit it could end the process, and since nothing is deleted from the mailbox,
end it again on every collection. The client now copies each response into one
buffer as it reads it, and reads the listing a line at a time from that buffer.
The same letter now costs a few megabytes.

A part of a multipart letter may start with a blank line and carry no headers.
Since the previous release, a whole letter that started with a line break was
read the same way. Its real headers then became body text, and the letter was set
aside as having no sender. Only a part is now read that way. At the start of a
letter, the line break is skipped.
