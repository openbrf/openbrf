# Backing up an Open BRF instance

**Back up the database and `/data/keys` together, in the same job, at the same
time. A database backup without the key is not a backup.**

Contact details and personal identity numbers are encrypted before they are
written (ADR 0002). The key that decrypts them lives on the data volume, at
`/data/keys/field-encryption.key`, and nowhere else. A database dump taken
without it holds those columns as ciphertext that nothing can ever read again:
there is no recovery path, no reset, and no support address that can help. The
names and postal addresses in the member register survive, because those are
stored in plaintext on purpose - the statutory register has to be searchable and
printable - but everything else is gone.

The instance is built to make that failure loud rather than silent. On any boot
after the first, a missing key file stops the container with an explanation
instead of generating a new one, because the usual cause is a volume that was
not mounted rather than a genuine first start.

## What has to be backed up

| What                        | Where                                                           | Why                                                              |
| --------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| The database                | the `postgres-data` volume, through `pg_dump`                   | The registers, the accounts, the audit log                       |
| The field encryption key    | `/data/keys/field-encryption.key` on the `instance-data` volume | Without it the encrypted columns in the dump are unreadable      |
| The rest of the data volume | `/data/uploads`, `/data/plugins`, `/data/themes`                | Uploaded documents, and the plugins and themes the instance runs |
| The environment file        | `.env.production` next to the compose file                      | `BETTER_AUTH_SECRET`, the database passwords                     |

Two things are deliberately **not** in that list. The application image is
rebuilt from the repository, and the PostgreSQL data directory itself is never
copied file by file: a directory copied out from under a running server is not a
consistent backup, and it is not portable across major PostgreSQL versions.
Always dump.

## Taking a backup

Run this against a running stack. It produces one directory holding a dump and
the data volume, which is the unit that has to be restored together.

```sh
#!/bin/sh
set -eu

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="./backups/${STAMP}"
mkdir -p "${OUT}"
chmod 700 "${OUT}"

# The database, as a custom-format dump so pg_restore can be selective.
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U openbrf -d openbrf --format=custom \
  > "${OUT}/openbrf.dump"

# The data volume, key included. Same job, same moment, one archive.
docker compose -f docker-compose.prod.yml exec -T app \
  tar -cf - -C /data . \
  > "${OUT}/data.tar"

echo "backup written to ${OUT}"
```

`pg_dump` runs inside the database container, so its version always matches the
server. Do not run a `pg_dump` from the host or from the application container
against a newer server; it refuses, and rightly.

## Storing a backup

The dump contains the housing cooperative's member register and the personal
data of everyone in it, and the archive contains the key that unlocks the rest.
Together they are the whole instance.

- Encrypt the backup at rest, and hold the passphrase somewhere other than the
  server being backed up.
- Keep at least one copy off the machine. A backup on the same disk protects
  against a mistake, not against a failure.
- Restrict who can read it the way you would restrict who can read the register
  itself, because it is the register.
- Test a restore. An untested backup is a belief, not a backup.

## Restoring

Into an empty stack:

```sh
# 1. Start the database alone, so nothing writes while the restore runs.
docker compose -f docker-compose.prod.yml --env-file .env.production up -d db

# 2. Put the data volume back first. The application refuses to start without
#    the key, which is the behaviour that keeps a half restore from writing
#    ciphertext nothing can read.
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  --no-deps --entrypoint sh app -c 'tar -xf - -C /data' < backups/<stamp>/data.tar

# 3. Restore the database.
docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U openbrf -d openbrf --clean --if-exists \
  < backups/<stamp>/openbrf.dump

# 4. Start the application. The entrypoint applies any migrations the restored
#    database is missing, reinstalls the job schema and reapplies the runtime
#    role's privileges.
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

Restore the key file and the dump from the **same** backup. A key from one
backup and a database from another decrypts whatever the two happen to share and
nothing else, and the failure looks like corrupt data rather than like a
mismatch.

`BETTER_AUTH_SECRET` is not needed to read the data, but changing it signs
everyone out, so restore the environment file too unless you mean to.

## Moving between PostgreSQL major versions

A PostgreSQL data directory is not portable across major versions, so a volume
created by an earlier major cannot simply be mounted into a newer server. Move
real data by dump and restore, or with `pg_upgrade`. Recreating the volume is
never the answer: it deletes the member and apartment registers, which the
housing cooperative is legally obliged to retain and to produce on request.

## Key rotation

There is none yet. Rotating the field encryption key means decrypting every
encrypted column and every blind index and rewriting them under a new key, and
that tooling is deliberately out of phase 1 (ADR 0002, ADR 0004). Until it
exists, treat the key as permanent: back it up, and do not change it.
