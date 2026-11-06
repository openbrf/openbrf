---
"@openbrf/api": patch
---

A photograph or file uploaded to an issue no longer stays in storage for good
when the server stops between storing it and placing it on the issue.

An upload stores the file first and then, in a step of its own, records which
issue it belongs to. A server that stopped between the two - a deployment, a
crash, a lost database connection - left a file on no issue. Its address was
never shown to anybody, but nothing removed it either: the clock on an issue's
free text and a granted erasure request reach files through their issue.

A nightly job now removes such a file, with its bytes, on its first run after
a day has passed since the upload. A run removes at most 500 such files,
oldest first, so a larger backlog takes several nights. A file whose removal
fails is tried again the next night, and the run goes on to the files behind
it. When 20 removals in a row fail, as they do when storage is down, the run
stops and leaves the rest to the next night. The job keeps a file that
anything holds, and a file whose uploader is under a legal hold or a
restriction of processing. The audit log records each removal without the
file's name.
