# ADR 0006: Encryption key provisioning and custody

Date: 2026-08-28

## Status

Accepted

Extends [ADR 0002](0002-field-encryption-and-blind-indexes.md), which settled
the encryption construction and named the key file. This record covers where the
key comes from, who is allowed to create one, and what happens when it is
missing.

## Context

Open BRF encrypts email addresses, phone numbers and personal identity numbers
at rest, with a blind index per searchable field. One symmetric key covers all
of it. Losing that key loses the data: there is no recovery path, and no
escrow.

Two failure modes have to be told apart, and they look identical on disk:

1. **A genuine first boot.** An empty database, no key, nothing to lose. A key
   has to be created or the instance cannot start at all, and asking a volunteer
   board treasurer to generate one by hand before their first start is a step
   many of them will get wrong.
2. **A missing data volume.** A populated database, and a key that exists in a
   backup or on the machine the volume was supposed to be mounted from.
   Generating a key here is the worst possible outcome: the instance starts,
   looks healthy, cannot read a single encrypted field, and the first write of
   an encrypted field replaces a readable value with ciphertext under a key that
   no backup knows about.

The application cannot distinguish them. `EncryptionKeyProvider` runs after the
process has already been configured, and it sees only the file system. It
therefore refuses to generate a key when `NODE_ENV` is `production`, which is
correct and leaves the first-boot case unsolved.

Nothing in the deployment is in a position to decide except the container
entrypoint, which runs before the application and before migrations, and can
therefore ask the database a question the application never can.

## Decision

- **The container entrypoint provisions the key, and only on a genuine first
  boot.** Before migrations run, it asks the database how many migrations have
  been applied. Zero, or no `_prisma_migrations` table at all, means a first
  boot: it writes 32 random bytes as lowercase hex to
  `${OPENBRF_DATA_DIR}/keys/field-encryption.key`, mode `0600` in a directory at
  `0700`, and says so in the log along with the backup requirement. Any other
  answer is a refusal to start, naming the missing path and the two ways out:
  restore the key file, or set `OPENBRF_ENCRYPTION_KEY`.
- **The application never generates a key in production.** The behaviour already
  in `EncryptionKeyProvider` stands, and is now the second line rather than the
  only one. Outside production it still generates one, because a developer's
  throwaway database has nothing to lose.
- **`OPENBRF_ENCRYPTION_KEY` overrides the file** and skips provisioning
  entirely, for a hosting platform that injects secrets and mounts no writable
  volume.
- **The key never leaves the data volume.** It is not written to the database,
  not printed on start, and not exposed by any endpoint.
- **Backup documentation is part of this decision, not an afterthought.**
  `docs/backup-and-restore.md` opens with the requirement to back up the
  database and `/data/keys` together, and the entrypoint's own log line on
  generation points at it.
- **Key rotation stays out of phase 1.** Rotating means decrypting and
  rewriting every encrypted column and every blind index. Recorded here as a
  known gap rather than left unsaid.

### Why the database is the signal

Migration count is the cheapest fact that separates the two cases, it is already
there before the application starts, and it cannot be faked by the file system
state the failure is about. The alternatives were worse: a marker file on the
data volume is exactly what goes missing when the volume does, and an operator
flag means the answer comes from whoever is least placed to know.

## Consequences

- A first `docker compose up` works with no manual key generation, and produces
  an instance whose key is already the one that must be backed up.
- An instance whose data volume was forgotten fails to start with an explanation
  instead of starting and quietly destroying data. Restarting does not help, and
  it is not supposed to: the message names the fix.
- The entrypoint needs a database client before the application runs. It uses
  `psql`, which the image already carries for the runtime role hardening.
- Restoring a backup means restoring the key file **and** the dump from the same
  backup. A mismatch presents as unreadable fields rather than as an error, so
  the restore procedure states the pairing explicitly.
- The key is only as protected as the volume. A host backup that copies the
  volume copies the key; that is the intended behaviour and the reason the
  backup document treats a backup as being as sensitive as the register itself.

## Revisit triggers

- **A hosted offering.** Per-instance keys held in a KMS or an HSM change the
  custody model, and the override variable is the seam that already anticipates
  it.
- **Key rotation becomes necessary** - a disclosed backup, or a compliance
  requirement. The rotation tooling lands with its own record.
- **The first-boot signal stops being reliable**, for instance if a future
  deployment applies migrations outside the entrypoint. The question the
  entrypoint asks then has to change with it.
