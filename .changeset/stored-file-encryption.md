---
"@openbrf/api": minor
---

Encrypt every stored file at rest, each under a key of its own.

Archive documents, issue photographs, attachments mailed to the board, the
website's pictures and the logo are sealed by the instance before they reach its
disk or a storage bucket, with libsodium's `crypto_secretstream_xchacha20poly1305`
in 64 KiB chunks. Each file's key is 32 random bytes, encrypted under the
instance's key as the field `mediaFile.dataKey` and kept on the file's row, so
there is still one key to hold. Whatever the file is, storage holds
`application/octet-stream` under a key with no extension.

Serving decrypts as the file streams and verifies every chunk before its bytes
leave. A file answers only once its first chunk has verified, so a changed or
unreadable file gets the same 404 as a missing one and an error in the log that
names its id. A failure further in ends the transfer short. No range request is
served.

The checksum on a file's row, which is also its entity tag, is now a keyed hash
of the file under a key derived from the instance's, so the database on its own
cannot confirm that a known document is stored. Files stored before this change
are encrypted once, when the instance starts and before it listens; a file that
cannot be encrypted is left as it was, logged, and never served.

`sodium-native` 5.1.0 is a new dependency, pinned exactly; the field encryption
keeps its own 3.4.1. See ADR 0015, which also records that the key is backed up
once, apart, and kept out of every recurring backup.
