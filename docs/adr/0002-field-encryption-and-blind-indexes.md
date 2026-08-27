# ADR 0002: Field-level encryption and blind indexes

Date: 2026-08-27

## Status

Accepted

## Context

Open BRF stores statutory personal data: personal identity numbers, contact
details, and the confidential apartment register. The platform promises
"field-level encryption at rest with searchability", never end-to-end
encryption (E2E breaks search, import, automated mail, and the statutory
extracts the association is legally required to produce).

The chosen approach is the CipherSweet construction: authenticated encryption
per field, plus a _blind index_ per searchable field. A blind index is a
truncated keyed hash of the normalized plaintext, stored alongside the
ciphertext, so equality lookups are possible without decrypting every row.

`ciphersweet-js` is the JavaScript port. It carries real maintenance risk:
version 2.0.6 was last published 2022-09-28, roughly four years old, and it
depends on `sodium-plus`, which is equally quiet. Building the crypto core of
a GDPR-sensitive register on an unmaintained package needed verification
before anything else in the data layer was written.

## Decision

- **Use `ciphersweet-js`**, pinned to an exact version, reached exclusively
  through an internal crypto service. No application or Prisma code imports it
  directly, so the implementation can be replaced without touching callers.
- **Encrypted + blind-indexed fields:** email, phone, personal identity number.
- **Plaintext fields:** name and postal address. Both are statutory member
  register content that must remain searchable and printable; they are
  protected by access control and masking, not encryption.
- **Blind index hash choice is per field**, based on the measured cost below:
  - Personal identity number: **slow hash (Argon2id)**. The value space is
    tiny (a known birth date leaves about four unknown digits), so a leaked
    database must not allow an offline sweep of the index.
  - Email and phone: **fast hash (HMAC)**. Higher entropy, and these fields
    are written in bulk during import and read on every search.
- **Key provisioning:** the container entrypoint generates a key into
  `/data/keys` when absent; an environment variable overrides the file. Key
  loss is data loss, so backup documentation covers the database and
  `/data/keys` together, and the setup wizard states it explicitly.
- **Key rotation tooling is out of scope for phase 1** and is recorded here as
  a known gap rather than left unsaid.

### Spike outcome (measured 2026-08-27)

Verified empirically with `ciphersweet-js` 2.0.6 on Node 26.7.0:

- **It runs on Node 26.** Encrypt, decrypt, and blind index all work. The
  round trip is correct; note that `decryptValue` returns a `Buffer`, not a
  string, and `prepareForStorage` returns `[ciphertext, indexes]` where each
  index is a plain string. A test asserting string identity on the decrypted
  value fails misleadingly.
- **Ciphertext is randomized** (same input, different ciphertext) and **blind
  indexes are deterministic and distinct** across different inputs, which is
  exactly the property equality search depends on.
- **No native compilation is required.** `sodium-native` ships prebuilds for
  darwin-arm64, darwin-x64, linux-arm64, linux-x64 and win32-ia32, so the
  production image needs no build toolchain. The backend in use resolves to
  `SodiumNativeBackend`.
- **Cost differs by three orders of magnitude:** a slow-hash (Argon2id) blind
  index measured **43.8 ms per field operation**; the fast-hash (HMAC) variant
  measured **0.07 ms**. This is the single most important number for the
  import path.

## Consequences

- Search on email and phone is **equality-only on the full normalized value**.
  Incremental and partial matching is available for name and apartment number
  (both plaintext) but not for the encrypted fields. The search UI must
  reflect this rather than implying substring matching.
- **Import is CPU-bound on personal identity numbers.** At 43.8 ms per value,
  an import of 1000 persons spends roughly 44 seconds in Argon2id alone. Import
  therefore runs as a chunked pg-boss job with progress reporting, never
  inside a request.
- The dependency is stale, so the crypto service is the isolation boundary
  that makes the fallback cheap: the CipherSweet construction (AEAD field
  encryption plus a truncated keyed hash) is small enough to reimplement on
  Node's own crypto primitives, with Paragon's maintained PHP implementation
  as the reference.
- Never describe this as end-to-end encryption in product copy or docs.

## Revisit triggers

- **`ciphersweet-js` breaks on a future Node LTS** or its dependency tree
  picks up an unpatched advisory: implement the construction directly behind
  the existing crypto service interface.
- **Import performance becomes a complaint** in the pilot: reconsider whether
  the personal identity number blind index needs the slow hash, or precompute
  it outside the import critical path.
- **A maintained JS CipherSweet implementation appears**: reevaluate.
