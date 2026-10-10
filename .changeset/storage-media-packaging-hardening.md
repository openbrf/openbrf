---
"@openbrf/api": patch
---

Harden the archive store, the storage drivers and media files.

- A cached archive is kept when its declared digest cannot be read, a failed
  write leaves no temporary file, and a `file:` source must be a regular file
  read up to the size limit.
- The S3 driver keeps a path the endpoint carries, refuses empty, `.` and `..`
  key segments, does not retry a failing bucket ten times, and does not copy an
  upload. The local-disk driver refuses a key naming the uploads directory.
  `.env.example` names the bucket permissions needed, and the backup guide
  covers the bucket.
- An upload and its audit entry commit together. A deletion removes an
  unencrypted copy the row still names first, and two deletions of one file no
  longer fail. A public file's cached copy is revalidated on every use.
  Public files were served as `immutable` before, so an instance behind a CDN
  should purge `/api/media/*` from it once after upgrading.
