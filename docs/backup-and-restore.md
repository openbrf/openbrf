# Backing up an Open BRF instance

**Two rules. The encryption key is backed up once, when the instance is first
started, and kept apart from every backup. The database and the data volume are
backed up together, in the same job, at the same time, and without the key.**

Contact details and personal identity numbers are encrypted before they are
written (ADR 0002), and so is every stored file - documents, photographs,
attachments mailed to the board, the website's pictures and the logo (ADR 0015).
The key that decrypts all of it lives on the data volume, at
`/data/keys/field-encryption.key`. The names and postal addresses in the member
register are stored in plaintext on purpose - the statutory register has to be
searchable and printable - and so are the names, types and sizes of the stored
files.

Both halves of the first rule matter, and they fail in opposite directions:

- **A backup without the key cannot be read.** A database dump holds the
  encrypted columns as ciphertext, and the archive of the data volume holds the
  stored files as ciphertext. Without the key nothing can ever read them again:
  there is no recovery path, no reset, and no support address that can help.
- **A backup that carries the key opens everything in it.** Whoever gets hold of
  such a backup reads every encrypted column and every stored file, and the
  encryption protected nothing. That is why the key is kept out of every
  recurring backup and held somewhere else.

The key never changes, because there is no key rotation yet, so the copy made on
the first day is the key every backup ever taken needs.

The instance is built to make a missing key loud rather than silent. On any boot
after the first, a missing key file stops the container with an explanation
instead of generating a new one, because the usual cause is a volume that was
not mounted rather than a genuine first start.

## What has to be backed up

| What                             | Where                                                           | When, and where it goes                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The encryption key               | `/data/keys/field-encryption.key` on the `instance-data` volume | Once, on the first day, into two copies held apart from the server and from the backups. See "Keeping the key"                                                                             |
| The database                     | the `postgres-data` volume, through `pg_dump`                   | Every backup: the registers, the accounts, the audit log                                                                                                                                   |
| The data volume, without `keys/` | `/data/uploads`, `/data/plugins`, `/data/themes`                | Every backup, together with the database: the stored files, and the plugins and themes the instance runs                                                                                   |
| The environment file             | `.env.production` next to the compose file                      | With the backups, for `BETTER_AUTH_SECRET` and the database passwords - unless it holds `OPENBRF_ENCRYPTION_KEY`, in which case it holds the key and is kept with the key's copies instead |

Two things are deliberately **not** in that list. The application image is
rebuilt from the repository, and the PostgreSQL data directory itself is never
copied file by file: a directory copied out from under a running server is not a
consistent backup, and it is not portable across major PostgreSQL versions.
Always dump.

## Keeping the key

Copy the key out once, on the day the instance is first started, and before
anything is stored in it. A one-off container reads it, as the backup script
below does, and the copy goes straight into a file on removable media rather
than onto a screen or into a terminal's scrollback.

```sh
#!/bin/sh
set -eu

# Where the copy goes. Mount the device at this path first.
DEVICE=/media/usb
KEY="${DEVICE}/openbrf-field-encryption.key"

compose() {
  docker compose -f docker-compose.prod.yml --env-file .env.production "$@"
}

# The device has to be mounted, and this is checked before anything opens the
# file: a directory that exists while nothing is mounted on it takes the copy
# onto the server's own disk, where the key sits beside the data it protects
# and inside whatever backs the host up, while whoever ran this believes a copy
# left the building. (A host without mountpoint(1) can ask
# `findmnt -rno TARGET "${DEVICE}"` instead.)
mountpoint -q "${DEVICE}" || {
  echo "${DEVICE} is not a mounted device; mount it and run this again" >&2
  exit 1
}

(umask 077; compose run --rm --no-deps -T --entrypoint sh app \
  -c 'cat /data/keys/field-encryption.key' > "${KEY}")

# The check above proves a device was mounted, not that the bytes arrived, so
# the copy is read back and compared. cmp says nothing when the two are equal.
compose run --rm --no-deps -T --entrypoint sh app \
  -c 'cat /data/keys/field-encryption.key' | cmp - "${KEY}"

echo "key copied to ${KEY}"
```

Unmount the device before taking it out. Until it is unmounted the bytes may
still be in the host's cache rather than on the device.

Make two copies, one device at a time, each written by that script with its own
device mounted at `DEVICE`. Keep them apart from each other, from the server and
from wherever the backups are stored - two board members holding one each is the
usual shape. Two, because a key nobody can find loses the very restore it
exists for, and losing it loses every encrypted field and every stored file. A
copy written at any later time is written the same way, mount check and read-back
included.

If the key is supplied through `OPENBRF_ENCRYPTION_KEY` instead, it is not on
the volume at all: `.env.production` holds it, and that file is kept the way the
key's copies are, out of the backups.

## Taking a backup

The script below produces one directory holding a dump and the data volume,
which is the unit that has to be restored together. The key is not in it.

**The application is stopped for the length of it, and that is the point.** The
database and the data volume hold two halves of the same instance: a row names
an uploaded file, and the file lives on the volume. Taken while the application
is writing, the dump and the archive describe two different moments, and a
restore can produce rows pointing at files that are missing or at an older
version of them. The database container keeps running, because the dump comes
out of it.

```sh
#!/bin/sh
set -eu

compose() {
  docker compose -f docker-compose.prod.yml --env-file .env.production "$@"
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="./backups/${STAMP}"
mkdir -p "${OUT}"
chmod 700 "${OUT}"

# Nothing writes from here until the trap puts the application back, whether
# this script finished or failed.
compose stop app
trap 'compose start app' EXIT

# The database, as a custom-format dump so pg_restore can be selective.
compose exec -T db \
  pg_dump -U openbrf -d openbrf --format=custom \
  > "${OUT}/openbrf.dump"

# The data volume, without the key: a backup that carried it would open every
# encrypted column and every stored file in it. One archive, from the same still
# moment. A one-off container, because the application's own is stopped; -T
# keeps a pseudo-terminal from rewriting the bytes of the archive on their way
# out.
compose run --rm --no-deps -T --entrypoint sh app \
  -c 'tar -cf - -C /data --exclude=./keys .' \
  > "${OUT}/data.tar"

echo "backup written to ${OUT}"
```

`pg_dump` runs inside the database container, so its version always matches the
server. Do not run a `pg_dump` from the host or from the application container
against a newer server; it refuses, and rightly.

An instance that cannot be paused at all needs the two halves snapshotted
together at the storage layer - one filesystem or volume snapshot covering both
volumes at one instant - and a dump taken from that snapshot afterwards.
Anything else is two backups of two different moments.

## Storing a backup

The dump contains the housing cooperative's member register, with the names
and postal addresses of everyone in it in plaintext, and both halves carry what
the encryption leaves readable: the stored files' names and sizes, and the audit
log. The key is not in either, so the encrypted columns and the stored files in
them cannot be read by whoever holds the backup alone.

- Encrypt the backup at rest, and hold the passphrase somewhere other than the
  server being backed up.
- Keep at least one copy off the machine. A backup on the same disk protects
  against a mistake, not against a failure.
- Restrict who can read it the way you would restrict who can read the register
  itself, because it is the register.
- Test a restore, with the key taken from where it is kept. An untested backup
  is a belief, not a backup, and a restore test is the only proof that the
  key's copies are where they should be.

## Restoring

Into an empty stack:

```sh
# 1. Start the database alone, so nothing writes while the restore runs.
docker compose -f docker-compose.prod.yml --env-file .env.production up -d db

# 2. Put the data volume back. -T for the same reason as in the backup: a
#    pseudo-terminal would rewrite the bytes of the archive on their way in.
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  --no-deps -T --entrypoint sh app -c 'tar -xf - -C /data' < backups/<stamp>/data.tar

# 3. Put the key back from where it is kept, readable by the application alone.
#    Not needed when the key is supplied through OPENBRF_ENCRYPTION_KEY. The
#    application refuses to start without it, which is the behaviour that keeps
#    a half restore from writing ciphertext nothing can read.
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  --no-deps -T --entrypoint sh app \
  -c 'umask 077 && mkdir -p /data/keys && cat > /data/keys/field-encryption.key' \
  < /media/usb/openbrf-field-encryption.key

# 4. Restore the database.
docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U openbrf -d openbrf --clean --if-exists \
  < backups/<stamp>/openbrf.dump

# 5. Start the application. The entrypoint applies any migrations the restored
#    database is missing, reinstalls the job schema and reapplies the runtime
#    role's privileges.
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

The key from its own place, the dump and the archive from **one** backup. A
database from one backup and an archive from another describe two different
moments, and a key other than the one the instance was first started with
decrypts nothing: the failure looks like corrupt data and missing files rather
than like a mismatch.

`BETTER_AUTH_SECRET` is not needed to read the data, but changing it signs
everyone out, so restore the environment file too unless you mean to.

## Moving between PostgreSQL major versions

A PostgreSQL data directory is not portable across major versions, so a volume
created by an earlier major cannot simply be mounted into a newer server. Move
real data by dump and restore, or with `pg_upgrade`. Recreating the volume is
never the answer: it deletes the member and apartment registers, which the
housing cooperative is legally obliged to retain and to produce on request.

## Key rotation

There is none yet. Rotating the encryption key means decrypting every encrypted
column and every blind index and rewriting them under a new key, and that
tooling is deliberately out of phase 1 (ADR 0002, ADR 0004). Until it exists,
treat the key as permanent: keep its two copies, and do not change it. When
rotation exists, the kept copies are replaced by the new key, and a backup taken
before the rotation still needs the key it was taken under.
