# ADR 0015: Stored files encrypted at rest

Date: 2026-09-21

## Status

Accepted

Extends [ADR 0002](0002-field-encryption-and-blind-indexes.md) and
[ADR 0004](0004-encryption-key-provisioning.md): the key those records settle
now also protects every stored file, and the backup custody both of them record
is amended here.

## Context

Every file the instance stores - archive documents, issue photographs,
attachments mailed to the board, the website's pictures and the logo - is a
`MediaFile` row and an object in the configured storage driver. The local driver
writes under `<data dir>/uploads`, on the same volume as the field encryption
key; the S3 driver sends the bytes to a bucket run by somebody else, whom the
deployment guide already treats as a recipient. Until this record the media
service handed the driver the bytes it received, so the bucket, its operator,
its replicas and any backup of either held every file in the clear.

Encrypting by the instance protects a file wherever it is held apart from the
key: in a bucket and at whoever operates it, in a backup or a snapshot that does
not carry the key, and in an object left behind after its row was deleted, once
no database backup still holds that row. It makes a change to a stored file
detectable, so a replaced object is refused rather than served from the
association's own origin. It protects nothing against anyone who also holds
the key - code in the application process, root on the host, a disk image of
it, or a copy of a volume that carries the key beside the files - and it changes
nothing about who the application serves a file to, which the file's visibility
decides. The database keeps each file's name, type, size, visibility and
uploader readable, the audit log keeps the name of every file uploaded and
deleted, and the storage sees each object's size, time and key prefix.

No live instance exists. The first pilot is planned for December 2026, and the
only unencrypted stored files are in developer databases and in the test
stacks.

CipherSweet has a file mode of its own, and it does not serve a stream. It needs
seekable file descriptors, so it cannot read an S3 response; it authenticates a
whole file with one tag and verifies it in a full first pass before a second
pass decrypts, so every serve would read the file twice and the first byte would
wait for the last; and every file shares one key derived from two fixed
constants.

## Decision

### Every stored file, whatever its visibility

A PUBLIC file is readable without a session by whoever holds its identifier,
which is not the same as published: a website picture is stored PUBLIC whatever
page it sits on, a members-only page or a draft included, and an archive
document's visibility changes with its audience in a transaction that storage
cannot take part in. One format for every object is one invariant, checked by
one count. Installed themes and plugins, which hold no personal data and have to
stay loadable, are not stored files and are not encrypted.

### libsodium's secretstream, in 64 KiB chunks, through sodium-native 5.1.0

`crypto_secretstream_xchacha20poly1305`: one file split into chunks, each chunk
authenticated, their order fixed, and the last tagged final so a file cut short
is told apart from a whole one. The object is the 24-byte header, then each
64 KiB of the file with its 17-byte tag, the last chunk holding the rest and
tagged final. No additional data is bound in; the key belongs to one file.

`sodium-native` is pinned at 5.1.0 exactly and imported by one file,
`apps/api/src/crypto/stored-file-cipher.ts`, the rule the field encryption keeps
for `ciphersweet-js`. The code around libsodium buffers bytes to chunk
boundaries, counts them, and refuses what does not verify; it decides nothing
cryptographic. The secretstream tags are numbers in 5.1.0 and one-byte buffers
in 3.x, and the final-tag check is covered by tests that fail in both directions
if the comparison is written for the other form.

`ciphersweet-js` reaches libsodium through `sodium-plus`, which takes
`sodium-native` as a peer in the 3.x range. A peer resolves to what the packages
above it provide, so the API's own dependency on 5.1.0 would otherwise become
the field encryption's libsodium too. `pnpm-workspace.yaml` declares 3.4.1 a
dependency of `ciphersweet-js`, and the process loads the two builds side by
side.

### A key per file, wrapped under the instance's key

Each file is sealed under 32 random bytes of its own. That key is encrypted as
the field `mediaFile.dataKey` under the instance's key, through the same
CipherSweet derivation as every other encrypted field, and stored on the row as
`dataKeyCipher`. There is no second key regime: CipherSweet's derivation gives a
key that encrypts keys without a new secret, and the row is the place to keep
one wrapped key per file. Rotating the instance's key then re-encrypts one
column and rewrites no object; deleting a row deletes the only copy of its key
outside the database backups; a leaked file key opens one file.

The row says how its object is held, in `encryption` - `SECRETSTREAM_64K`, or
`NONE` for a row written before this record - with no default, so a new way of
writing a row cannot leave a file unencrypted by omission. A CHECK holds that a
row has a wrapped key exactly when it is encrypted.

### The media service is the seam

`MediaService` is the only caller of storage, and every feature that stores a
file calls its upload; the one route that serves a file calls its open. It seals
before anything is stored, so a failure stores nothing, and stores the object as
`application/octet-stream` under a key with no extension, which would otherwise
misdescribe the ciphertext and tell the storage's logs what kind of file it is.
The drivers move opaque bytes and do not change.

### Each chunk verified before it leaves, the first before any status

Serving decrypts as the object streams. A chunk's plaintext is emitted only after
libsodium has verified it, and `open()` returns only once the first chunk has
verified, so a file whose key does not unwrap, whose header is wrong or whose
first chunk was changed answers with the same 404 as a missing file, and is
logged by its id. A failure in a later chunk ends the reply short of the
`content-length` already sent, which a client reads as a failed transfer. The
stream also fails if its length differs from the row's, so the header and the
body cannot disagree silently. No range request is served: a secretstream
cannot be entered in the middle.

### The checksum is a keyed hash of the file

The row's `checksum` is the entity tag on the serving path. It is CipherSweet's
blind index of the file's bytes at 256 bits, under the key CipherSweet derives
from the instance's key for `media_file.checksum` - a keyed hash, so a database
on its own cannot confirm that a document somebody already holds is stored
here, and no new key is held for it. It is computed over the file as uploaded,
so it is stable for a file whatever key the file is later sealed under. Two
rows that hold the same bytes carry the same checksum.

### The files already stored are encrypted once, at start

`StoredFileEncryptionService` encrypts every `NONE` row from `onModuleInit`,
before the server listens. For each it reads the object, checks it against the
row's size and the plain SHA-256 the row was written with, seals it under a new
key, writes it under a new storage key, reads it back and opens it, switches the
row with an update that holds only while the row still names the old key and is
still `NONE`, and then removes the old object. `MediaService.open` refuses a
`NONE` row as missing, so no path serves an unencrypted file. Blocking start is
cheap only because no live instance holds files; nothing writes `NONE` any
longer, so none can come to.

The unencrypted object is the one thing the job must not lose track of. The
update that switches a row also records the old key in `unencryptedStorageKey`,
and the column is cleared only once the removal has succeeded; every run tries
the removals still recorded before anything else, and deleting a file removes
its recorded object too. A CHECK keeps the column on encrypted rows only, and
never naming the object the file is served from. An encrypted object orphaned
by an ordinary delete needs no such record, because its key went with the row.

A fact about one file - its object gone, or not matching its recorded size and
checksum - leaves that file as it was, logged by id, and the run goes on, so one
corrupt file cannot keep the instance down. A failure of the run itself - the
database or the storage not answering - stops the start, loudly, rather than
serving every unencrypted file as missing. That costs nothing on any other
start, because the job only has work while an unencrypted file is left.

The record of processing activities says the files are encrypted, on each
processing that stores them, only while no stored file has bytes in storage
that are not: no `NONE` row and no recorded unencrypted object.

### The key is backed up once, apart, and kept out of every backup

This amends ADR 0002, which has backups cover the database and the key together,
and ADR 0004, which has a restore take the key and the dump from the same
backup. A backup that carries its own key is protected only by whatever protects
the backup, and with files encrypted it opens every file as well as every
encrypted field. The key is copied out once, on first boot, into at least two
copies held apart from the server and from the backup store; every recurring
backup excludes it; a restore puts it back from where it is kept. The key never
changes while there is no rotation, so the one copy serves every backup ever
taken. A key supplied through `OPENBRF_ENCRYPTION_KEY` is held in the
environment file, which is then kept with the key's copies rather than with the
backups. `docs/backup-and-restore.md` is the procedure.

### What this is not

Not end-to-end encryption: the instance reads every file it serves. Not access
control. And not a protection of metadata.

## Consequences

- Losing the key now loses every stored file as well as every encrypted field.
  The two copies exist for this.
- An instance restored with the wrong key answers every file as missing and logs
  an error for each; the entrypoint's refusal catches a missing key, not a wrong
  one.
- Recovering from a compromise of the key together with the database means
  sealing every object again under new keys, which is the job's loop.
- An upload holds one more buffer the size of the file while it is sealed.
  Serving holds at most one sealed chunk and the slice that arrived with it.
- A revalidation opens the file and verifies its first chunk before the entity
  tag is compared.
- A stored object is at most 24 bytes and 17 per 64 KiB larger than its file.
- The process loads two libsodium builds until `ciphersweet-js` is replaced.

## Revisit triggers

- **Range requests are wanted.** A range would mean decrypting from the start
  and discarding up to it.
- **A hosted offering**, with keys held in a KMS or an HSM (ADR 0004).
- **Key rotation lands.** The kept copy is replaced, an older backup needs the
  key it was taken under, and the keyed checksums change with the key.
- **`ciphersweet-js` is replaced** (ADR 0002), at which point the key wrap and
  the file cipher move onto one libsodium build.
- **An upload path that streams end to end**, which sealing a whole buffer
  would then have to follow.
- **No database holds a `NONE` row or a recorded unencrypted object any
  longer**, at which point the job, the value and the column go.
