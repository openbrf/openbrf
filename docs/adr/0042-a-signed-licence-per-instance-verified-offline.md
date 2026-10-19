# ADR 0042: A signed licence per instance, verified offline

Date: 2026-10-19

## Status

Proposed

Answers the questions in the stub for the entitlement to run a paid plugin
(draft ADR 0036 in #411) and provides what paid themes need from the instance
licence (draft ADR 0036 in #410). Leaves digital signage's entitlement where
draft ADR 0034 (#404) puts it, in the pairing service.

## Context

GOVERNANCE.md and ROADMAP.md say a module is paid when it needs Apteo's own
infrastructure or "carries per-instance licensing". The MCP Connector and the
AI package are the first modules of the second kind. With a provider key the
association configures itself, neither needs anything Apteo hosts while it
runs, so no service of Apteo's is in a position to refuse an instance that has
not paid.

Nothing in the core can express a licence today:

- The host object has no licence or entitlement member
  (`packages/plugin-sdk/src/host.ts:200-222`).
- Neither a manifest nor a catalog entry can say that a plugin needs one
  (`packages/plugin-sdk/src/manifest.ts`, `packages/plugin-sdk/src/catalog.ts`).
- An instance has no identity a licence could name. The `Association` row is
  pinned to id 1 on every instance, its `organizationNumber` is nullable and
  names the association rather than the instance, and `APP_URL` is an address
  that changes when an association moves domain.

Four things are already fixed and this decision keeps them:

- No feature of the core depends on a licence, and none is ever moved behind
  one (GOVERNANCE.md, "The open core boundary").
- A running instance never contacts a package registry
  (`docs/deployment.md`), and nothing in the core calls Apteo.
- Paid modules are ordinary plugins on the public plugin API.
- The source of a paid module may be readable by anyone who holds it, so any
  check in it can be removed. That risk is accepted. What a check in open code
  can do is make the terms plain and the honest path the easy one. Where Apteo
  hosts something a module needs, that service verifies the same licence, and
  that is where an entitlement can actually be enforced.

## Decision

### The licence is a file Apteo signs, and the instance verifies it offline

A licence is a small JSON document:

```jsonc
{
  "format": "openbrf-licence/1",
  "keyId": "apteo-2026-1",
  "payload": "<base64url of the payload's UTF-8 JSON>",
  "signature": "<base64url Ed25519 signature>",
}
```

The signature covers the bytes `openbrf-licence/1\n` followed by the payload
bytes exactly as they appear base64url-decoded. Nothing is canonicalised and
the payload is not parsed until the signature has verified. The prefix keeps a
signature made for a licence from being valid for anything else the same key
might ever sign. Node's own `crypto` verifies Ed25519, so the core takes on no
dependency for it.

The payload:

```jsonc
{
  "licenceId": "9b0c7c5e-2f4e-4d8a-9a51-3a3f0a5f1c2d",
  "issuedOn": "2026-11-02",
  "instanceId": "4f1d2a9e-7c3b-4b6e-8f0a-1d2c3b4a5e6f",
  "instanceKey": "<base64url of the instance's 32-byte Ed25519 public key>",
  "association": {
    "name": "Brf Talgoxen 4",
    "organizationNumber": "769600-0000",
  },
  "entitlements": {
    "ai-package": { "validUntil": "2027-11-30" },
    "mcp-connector": { "validUntil": "2027-11-30" },
  },
}
```

- **An entitlement per module.** A licence carries any number of them, so one
  file can hold `mcp-connector`, `ai-package` and `themes`. An entitlement's
  name is the issuer's to choose, written as a plugin id is: 2 to 48 lowercase
  letters, digits and single hyphens. Apteo names each one after the plugin id
  that reads it, except where a module is several plugins.
- **Two optional dates per entitlement**, each a calendar date read on the
  association's calendar day ([ADR 0013](0013-the-association-s-calendar-day.md))
  and inclusive. `validUntil` is the last day the module may be used, and
  without it, use has no end. `updatesUntil` is the last release date the
  entitlement covers, and without it every release is covered. A licence sold
  once with twelve months of updates carries only `updatesUntil`. A
  subscription carries only `validUntil`.
- **No issuer in the payload.** Who issued a licence is whoever holds the key
  that verifies it. The licence screen and the audit log name the issuer from
  the manifest of the plugin whose key verified it, never from text in the
  file.
- **No personal data.** It names the association and the instance, never a
  contact person, a signatory or an email address. An organisation number of an
  economic association names a legal person. Presenting the licence to its
  issuer therefore sends nothing the consent screen has to ask about, and the
  licence is outside [ADR 0019](0019-every-column-that-names-a-person-is-answered-for.md).
- **Strict.** Version 1 refuses a field it does not know, at either level. A
  field that narrows what an entitlement allows, such as a usage cap, would
  otherwise be ignored by an older core. Adding one is version 2.

**One reading of every byte.** Only the issuer writes a payload, but the
instance and Apteo's services verify it with different code, and the two must
never read one signed file two ways:

- A licence file is at most 16 KiB (16,384 bytes). A presentation has its own
  limit ([The licence is presented with the instance's
  signature](#the-licence-is-presented-with-the-instances-signature)).
  `payload` and `signature` are base64url without padding, and a value that
  does not re-encode to the same string is refused, since Node's decoder
  otherwise skips characters it does not know. The signature is exactly 64
  bytes.
- `format` must equal the version the verifier supports, and is compared before
  anything is verified. The signed prefix is the verifier's own constant, never
  text taken from the envelope. `format` and `keyId` are outside the signature:
  they select how to verify and never assert anything. A `keyId` is 1 to 64
  characters of `a-z`, `0-9` and `-`.
- The payload is decoded as UTF-8 that refuses invalid bytes. A JSON object, in
  the envelope or the payload, that repeats a key is refused: `JSON.parse`
  keeps the last and other parsers the first, so one signed payload could
  otherwise name two instances.
- A date is `YYYY-MM-DD` and a real calendar day, so `2027-02-30` is refused
  rather than rolled over. `licenceId` and `instanceId` are canonical lowercase
  UUIDs, and they and `instanceKey` are compared as exact strings.
- The issuing tool builds the payload with a JSON serialiser, never by joining
  strings, so no association name or organisation number on an order can add a
  field.

Ed25519 rather than RSA or ECDSA: short keys and signatures, deterministic
signing, and no parameters to get wrong. Our own envelope rather than JWS: a
JWS verifier has to refuse every algorithm but one, and this envelope has no
algorithm field to refuse.

### The instance gets an identity, and the licence is bound to it

Each instance gets an **instance id**, a random UUID, and an **instance key**,
an Ed25519 key pair. The core creates both once (in the migration that adds
them, for instances that already exist, or at first start), keeps them in the
database and never changes them. Nothing on any screen or route writes them,
and no screen, route or data export returns the private key: only the host
signs with it ([The licence is presented with the instance's
signature](#the-licence-is-presented-with-the-instances-signature)). The
licence screen shows the id and the public key as one line, which the board
copies into its order.

The licence binds to the instance id and the instance key, and to nothing
else:

- **It follows the association's data, not the machine.** A backup restored on
  another host, a move to a hosted instance, or a new domain keeps the id, the
  key and the licence with them. An instance set up afresh, with its data
  imported rather than restored, has a new id and key and needs its licence
  reissued.
- **Not to `APP_URL`.** A domain changes, staging copies run under another
  name, and every development instance is on `localhost`. Changing the address
  already disconnects every connected app (`docs/deployment.md`). It should not
  also cost the association its licence.
- **Not to the organisation number.** It is nullable until the board enters
  it, and one association could run two instances under one number. It is in
  the licence so the licence screen can show who it was issued to, and it is
  not compared.
- **Not to the hardware.** A container has no stable hardware, and a licence
  that broke on a host move would punish the association for doing what
  backup-and-restore.md tells it to.

A restored backup started beside the original carries the same id and key, so
two copies run on one licence. The terms forbid that and the code does not try
to stop it. Apteo's services see one licence used from two places, as
described under [Where enforcement is real](#where-enforcement-is-real). A
backup holds the instance key, which is one more reason, after the personal
data in it, to keep backups as secret as the database.

### The core holds and verifies licences, and plugins read the result

**Entering a licence.** The board enters a licence file on the core's
**licence screen**, under the capability that installs plugins
(`association:manage`), or an operator enters one with the command-line tool.
The core keeps every licence entered until the board removes it, at most 50,
and refuses a file over 16 KiB.

A key is known by its fingerprint, the SHA-256 of its public key. A `keyId`
only selects which keys to try, because two plugins can declare the same
`keyId` with different keys. When a file is entered, the host tries it against
every installed plugin's key with that `keyId`:

- If one verifies it, the licence is stored as checked, with the fingerprint
  of the key that verified it.
- If keys with that `keyId` are declared and none verifies it, or the file is
  not a licence at all, it is refused and not stored.
- If no installed plugin declares the `keyId`, it is stored as **not yet
  checked**, so the board can enter the licence before installing the module.
  The core does not parse its payload. It keeps the file as opaque bytes, and
  the licence screen shows only the `keyId`, the file's SHA-256, the date it
  was entered and "not yet checked". When a plugin that declares the `keyId` is
  installed or updated, the host tries the file against that plugin's keys,
  and a file that does not verify stays not yet checked: it may be meant for a
  plugin still to come.

The audit log gets `LICENCE_ADDED` with the file's SHA-256, its `keyId` and
whether it verified; `LICENCE_VERIFIED` with the licence id, the issuer from
the verifying plugin's manifest, the entitlement names and their dates, when a
key verifies it, at entry or later; and `LICENCE_REMOVED` with the SHA-256
and, for a checked licence, its id. Nothing unverified ever appears there as a
fact, and every string from a payload is shown and logged as text, never as
markup. Nothing in a checked payload is personal data, so there is nothing
else to keep out of the log.

Several licences can stand side by side. An association that bought the
connector outright and later subscribes to the AI package holds two files.
When the subscription lapses, the connector's own file still covers it, and no
issuing rule has to merge the two.

**A plugin declares the licence it reads.** A licensed plugin's manifest names
one entitlement, the issuer it trusts and that issuer's public keys, and the
services it may present the licence to:

```jsonc
"licence": {
  "entitlement": "themes",
  "issuer": { "name": "Apteo AB", "url": "https://openbrf.se/licence" },
  "keys": { "apteo-2026-1": "<base64 Ed25519 public key>" },
  "audiences": ["https://themes.openbrf.se"],
},
"released": "2026-12-01",
```

`released` is the release date the release workflow writes into the manifest,
compared with `updatesUntil`. Each of `audiences` is an origin of at most 256
characters, and a manifest that declares a longer one is refused. A plugin that
uses no service of its issuer's, such as the connector, declares no
`audiences`. The keys sit with the plugin rather than in the core, so the core
holds no vendor's key and has no rule that is about Apteo. Anyone who sells a
plugin can issue licences for it in the same format.

A plugin reads only licences that one of its own keys verified, judged by
fingerprint, so a licence another plugin's key verified never shows in its
state. What a plugin gets from a licence it does read is more than the licence
screen shows: through `present()` it can show Apteo's services that this
instance holds the entitlement, which is worth the association's paid use of
them. So a plugin's `licence` is a grant the board consents to, as it does
`permissions`, and the catalog vouches for it:

- The catalog lists a plugin whose `licence` names an issuer only when that
  issuer publishes the plugin, and only with keys the issuer publishes at
  `issuer.url`.
- It refuses a listing that declares a `keyId` another listed plugin declares
  with a different key.

**Who verifies: the host.** It verifies on read, against the plugin's declared
keys and the instance's own id and key, on the association's calendar day:

```ts
interface PluginEntitlements {
  /** The entitlement the manifest names, judged today. */
  get(): Promise<EntitlementState>;
  /**
   * The active licence with a fresh signature by the instance key, for one of
   * the audiences the manifest declares. Null without an active licence.
   */
  present(audience: string): Promise<string | null>;
}

type EntitlementState =
  | {
      status: "active";
      licenceId: string;
      validUntil: string | null;
      updatesUntil: string | null;
    }
  | { status: "absent" }
  | { status: "expired"; licenceId: string; validUntil: string }
  | {
      status: "version-not-covered";
      licenceId: string;
      updatesUntil: string;
      released: string;
    }
  | { status: "wrong-instance"; licenceId: string }
  | { status: "tampered" }
  | { status: "not-yet-valid"; licenceId: string; issuedOn: string };
```

`host.entitlements` is present only on a plugin whose manifest declares a
`licence`, and plugins feature-detect it as they do `host.actions`. An active
licence wins over every other. With none active, `get()` reports the finding of
the most recently entered licence that names the entitlement and that one of
the plugin's keys verified. A licence that names the entitlement under another
instance id or instance key is `wrong-instance`. `tampered` is a licence
stored as checked under one of the plugin's own keys that no longer verifies,
because its row was changed after it was entered. A file that fails a key of
another plugin, or that is still not yet checked, is never `tampered` for this
one. `not-yet-valid` covers an `issuedOn` after today, which is a wrong clock
on one side or the other.

One verifier in the host, not one per plugin: one parser to get right and
test, one screen the board enters a licence on once, and the instance id, the
instance key and the calendar day, which only the core has, applied the same
way everywhere.

### The licence is presented with the instance's signature

A licence file alone is not a credential. The id and public key in it are
printed on the licence screen, and a file is easily copied: into a support
mail, a screenshot, a backup. `present(audience)` gives a plugin what it shows
its issuer's service, the theme pack service in #410 and later Apteo's AI
gateway, without ever handing it the instance's private key:

```jsonc
{
  "format": "openbrf-licence-presentation/1",
  "licence": "<base64url of the licence file's bytes, as entered>",
  "claims": "<base64url of the claims' UTF-8 JSON>",
  "signature": "<base64url Ed25519 signature by the instance key>",
}
```

```jsonc
{
  "audience": "https://themes.openbrf.se",
  "licenceId": "9b0c7c5e-2f4e-4d8a-9a51-3a3f0a5f1c2d",
  "entitlement": "themes",
  "issuedAt": "2026-12-03T09:14:05Z",
  "nonce": "<base64url of 16 random bytes>",
}
```

The host signs the bytes `openbrf-licence-presentation/1\n` followed by the
claims, and writes the presentation and the claims as compact JSON. The rules
under "One reading of every byte" hold for the presentation, its claims and
the licence inside it, except for the size limit: a presentation is at most
24 KiB (24,576 bytes), and a service refuses a longer one before parsing it.
The licence inside, once decoded, is held to 16 KiB as on the instance. The
licence travels as base64url of its bytes rather than as a JSON string, so its
size in the presentation does not depend on how the file was written: the
largest licence the core accepts takes 21,846 characters, and with the longest
audience and entitlement name allowed, the whole presentation takes 22,621
bytes. Every licence the core accepts can therefore be presented.

The host fills in `licenceId` from the licence it presents and `entitlement`
from the manifest, so a plugin can present only the entitlement it declares,
even from a file that carries several. It refuses an `audience` that is not an
origin among the manifest's `audiences`, compared exactly. A service checks:

- the licence, under its own table of the issuer's keys (see [Keys](#keys));
- the licence against the issuance ledger: the ledger holds an entry for the
  `licenceId` in the verified payload, the SHA-256 of the payload bytes the
  signature covers equals the hash recorded in that entry, and the id is not
  on the revocation list;
- that the claims' `licenceId` equals the `licenceId` in the verified payload;
- the claims' signature, under the `instanceKey` in that licence;
- that `audience` is its own origin and `entitlement` is the one it serves,
  and that the licence grants it today;
- that `issuedAt` is within five minutes of its own clock and the `nonce` has
  not been seen in that window.

A presentation made for the theme pack service is therefore useless at the AI
gateway, a copied licence file is useless at both, and a presentation caught in
transit is useless after five minutes. The board enters a licence once, never
again in a plugin's settings.

**Before install, the board is told.** The catalog entry mirrors the manifest's
`licence` and `released`, as it mirrors `permissions`. The install screen and
the consent screen say that the module needs a licence from the named issuer
and does nothing without one, and, for each audience, that the module may
present the association's licence for the entitlement to the issuer at that
address. When an update would be released after the installed licence's
`updatesUntil`, the update screen says so before the board updates and stops
being covered.

### What stops when the licence is absent or lapses

Without an active entitlement, a module is **dormant**:

- **MCP Connector.** Its route stays mounted and authenticates a request
  exactly as it does while licensed, so a caller without a valid token gets the
  same 401 from a dormant connector as from an active one, and learns nothing
  about the licence. To a client with a valid token it answers every MCP
  request with an error with the reason `entitlement-required`, and no dates.
  It lists no tools and makes no calls. Its admin screen shows the state, the
  dates and where to get a licence.
- **AI package.** It accepts no new prompt and sends nothing to the provider.
  Its screen shows the state. A change it proposed while it was licensed stays
  the board's to confirm or discard until that proposal expires, as any
  proposal does: confirming is the board's act, and nothing new is generated.
- **Paid themes.** As #410 decides: no new downloads or updates.
- Any action a dormant module registered itself refuses with the reason
  `entitlement-required`, the same reason draft ADR 0034 gives for pairing.
  The registry's refusal vocabulary is to be stated in the SDK (APT-5802).

A dormant module is not switched off. Switching a plugin off is the board's
act, and the core never does it for a licence. Its settings and the arming of
its actions stay as they were, so a renewed licence brings back exactly what was
there before, without anybody setting it up again.

**Lapsing comes without a grace period in the code.** The issuer writes any
grace into `validUntil`. Apteo issues a subscription's licence to the end of the
paid period and adds fourteen days. From thirty days before `validUntil`, the
licence screen and the module's own screen say when it ends. Nothing is mailed
because of it.

**A licence for updates never stops what it covers.** A connector bought once
runs forever on every release from on or before its `updatesUntil`. Only a
later release reports `version-not-covered`, and the update screen says so
before the board installs it.

### What never stops

Whatever the licence says, and whether there is one:

- **Every core feature.** The action registry, arming, sign-in for MCP clients,
  the connected apps screen and revoking a connected app, the audit log, the
  consent screen, the data protection record and the licence screen itself.
  These are free core, and none of them reads a licence.
- **What a module did.** Content written through the connector or the AI
  package was written by the person who confirmed it, and it stays as written.
  Its audit entries stay. Installed themes stay installed and active.
- **The board's control over the module.** Switching it off, removing it,
  disarming its actions, revoking connected apps and exporting the
  association's data are never gated on a licence.
- **Working offline.** Verifying a licence makes no network call, and the core
  never reports a licence or its use to anybody. `present()` signs without a
  network call too; only the plugin that asked for it sends the result, to an
  audience the board consented to.
- **The rest of the instance.** A missing, lapsed, copied or forged licence
  makes one module dormant. It is never a reason for the core to refuse to
  start, to load a plugin or to serve a page.

### How the AI licence unlocks the connector

The AI package includes the MCP Connector. The licence says so explicitly,
rather than the core or either plugin deriving one entitlement from another: a
licence for the AI package carries both `ai-package` and `mcp-connector`. The
connector reads only `mcp-connector`. The AI package reads only `ai-package`,
and dispatches through the registry on the `ai` channel without the connector
installed. An association that holds the AI package can install the connector
and use it without buying anything more, and the products' relation is a rule
of Apteo's issuing that can change without a release of either plugin.

By default the included connector entitlement has the subscription's
`validUntil`. Whether a subscriber keeps the connector after leaving, as if
they had bought it once, is a pricing decision. The answer is written into the
licences Apteo issues, with no change to the code.

### Where enforcement is real

A check in a plugin's code, in the core it runs on, or in the database rows
holding the instance id and key can be removed or edited by whoever runs the
instance. Within the instance, this design stops honest mistakes: running a
module nobody bought, a licence copied from another instance, a forged or
altered file, an update the licence does not cover. It does not stop a
determined operator, and does not try to.

Where a module uses something Apteo hosts, that service takes a presentation
as its credential and checks it as described under [The licence is presented
with the instance's signature](#the-licence-is-presented-with-the-instances-signature):
the theme pack service (#410), Apteo's AI gateway when it exists, and digital
signage's pairing service if signage adopts this licence. They also hold the
only revocation there is, a list of revoked licence ids. An instance cannot
learn of a revoked licence without calling home, so on the instance a licence
ends only on its dates. That is one reason subscriptions are issued for the
period paid, not for a year ahead.

A service also sets its own end to an entitlement without a `validUntil`, so
that a licence that runs forever on the instance is not a credential that
runs forever at Apteo. The theme pack service serves only the releases up to
its `updatesUntil`. An AI gateway, whose every request costs Apteo, accepts an
entitlement only with a `validUntil`.

These services see which licences are presented from where. Two copies
restored from one backup hold the same instance key, so they show there only
as one licence used from two places at once, not as two holders the service
can tell apart. Someone with the database holds the instance key too; that is
the operator this design already concedes.

### Keys

**Custody.** Apteo's signing key is created in a cloud key management service
as a non-exportable Ed25519 key, so it is never in a repository, in CI, on an
instance or on anybody's machine. The issuing tool asks the service to sign
and never holds the key. Only named Apteo people may ask, and the service logs
every signature.

**The issuance ledger.** The issuing tool records every licence it issues: the
licence id, the SHA-256 of the payload bytes it had signed, the instance id and
key, the entitlements and their dates, and who issued it. The licence id is a
fresh random UUID, and the ledger refuses an entry whose id it already holds,
so an entry never changes once written. Apteo's services accept only a licence
whose payload hashes to the hash the ledger records for its licence id, and
which is not revoked. The hash covers every byte that was signed, so a payload
that reuses an issued licence id with another instance key, another
entitlement or another date does not match its entry. Each service keeps its
own table of Apteo's key ids and public keys, each key revocable on its own,
and never trusts the keys a plugin's manifest carries. A leaked signing key
then mints licences that installed releases accept, which is the operator risk
already conceded, and nothing that a service accepts: a payload the issuing
tool did not write has no entry to match, under a new licence id or a reused
one.

**Rotation.** Each key has a `keyId`. A new key is declared in a plugin release
before any licence is signed with it, and a plugin declares at most two at
once. If a key leaks, the services drop it at once, a release drops it from the
plugins, and every licence it signed is reissued under the next key. Releases
already installed trust it until they are updated: offline verification has no
other revocation, and on the instance the check is advisory anyway.

**Issuing and testing.** Issuing is a command in the modules' repository for
now. It builds the payload, asks the key service to sign it and writes the
ledger entry. The test environment has its own issuing key, a separate key in
the same service with a `keyId` starting `apteo-test-`, and its own ledger, so
its licences are verified exactly as an association's would be and the modules
are tested with the licence checks on. A test build of a module declares the
test key; a released manifest never does. The modules' repository keeps the
list of Apteo's production public keys, the same list published at
`issuer.url`, and the release workflow fails a release whose `licence.keys`
holds any other. A plugin's own tests sign with a throwaway key generated in
the test, and the SDK offers a test double for `host.entitlements`.

## Alternatives rejected

- **Online activation.** The instance would call Apteo to start or keep a
  module running. It would be the first call a running instance makes to its
  vendor, and an outage at Apteo, or Apteo closing, would stop modules an
  association paid for. It is deferred, not
  rejected outright, as an opt-in convenience for fetching a renewed licence
  (see the revisit triggers).
- **No licence check in open code**, as draft ADR 0034 concludes for signage.
  Right for signage, which has a pairing service to enforce it in. The
  connector and the AI package have no such service while the association uses
  its own provider key, and without a check "per-instance licence" would be
  terms that nothing on the instance reflects, not even to the board that
  wants to stay within them.
- **The licence file itself as the credential to Apteo's services.** Whoever
  held the bytes would be the instance to Apteo: any plugin that names the
  entitlement, a leaked support mail or a copied backup, at every service the
  file's entitlements reach, and for good where a licence has no
  `validUntil`. A signature by an instance key, made fresh for one audience,
  costs the host one key pair.
- **Each plugin verifying its own licence.** Several parsers, several screens,
  and the board entering one licence once per module. The plugin also has
  neither the instance id and key nor the association's calendar day.
- **Apteo's public key built into the core.** It would be the core's first rule
  about one vendor, and nobody else could sell a licensed plugin on the same
  terms.
- **The host refusing to load an unlicensed plugin.** The core would then decide
  what a module withholds, so a lapsed licence could remove a free part of it,
  or an admin screen the board needs to see why. The module knows what is paid
  in it, and the core enforces what never stops, because all of that is the
  core's own.
- **Binding to `APP_URL`, the organisation number or the hardware.** See above.
- **One file per module.** More files for the board to keep, and the AI
  package's inclusion of the connector would become a rule in code.
- **JWS or a JWT library.** An algorithm field to police and a dependency, for
  a format with one algorithm.
- **A grace period in the code.** It would be a second date the core reads that
  the issuer cannot set. Grace written into `validUntil` is visible on the
  licence screen.

## Consequences

- The core gains an instance id and instance key, a table of entered licences,
  the licence screen and the CLI command, the audit entries, the manifest's
  `licence` and `released` fields and their catalog mirror, the install,
  consent and update screen notices, and `host.entitlements` with `present()`.
  It is all general, and none of it names Apteo. This is task C1 (APT-5784,
  APT-5746). Its tests cover:
  - valid, absent, expired, not-yet-valid, wrong-instance (by id and by key),
    tampered and version-not-covered licences, an unknown key, a strict-schema
    refusal, two licences side by side, and the calendar-day boundary at
    `validUntil`;
  - a payload with a repeated key, non-canonical base64url, a signature that is
    not 64 bytes, an impossible date, an uppercase UUID, an entitlement name
    that is not written as a plugin id is, and a file over 16 KiB, each
    refused, as is a manifest audience over 256 characters;
  - two plugins declaring one `keyId` with different keys: each licence
    verifies for its own plugin only, the genuine licence is not refused at
    entry, and neither plugin reports the other's as `tampered`;
  - a not-yet-checked licence, whose payload fields appear neither on the
    licence screen nor in the audit log;
  - `present()` refusing an audience the manifest does not declare, and a
    presentation that fails verification at another audience, for another
    entitlement or with another instance key;
  - the largest presentation there can be: a licence file of exactly 16 KiB,
    an audience of 256 characters and an entitlement name of 48, whose
    presentation is no longer than 24 KiB and verifies;
  - a dormant connector answering an unauthenticated request with the same 401
    as an active one.
- Apteo's services, outside this repository, check presentations as described
  above. Their tests cover:
  - a replayed or stale presentation, and a licence without a valid instance
    signature, each refused;
  - a licence signed with a key the service trusts but missing from the
    ledger, refused;
  - a licence signed with a key the service trusts that reuses a licence id
    the ledger holds, with another instance key, another entitlement or a
    later date, refused because its payload hash does not match the entry,
    even when the claims are validly signed by the instance key it names;
  - claims whose `licenceId` is not the licence's, refused;
  - the largest presentation the core can produce accepted, and one byte
    over 24 KiB refused before parsing.

  The modules' release workflow fails on a key in `licence.keys` that is not
  in the published list.

- The catalog's listing checks gain the issuer and `keyId` rules, and its
  review of a licensed plugin looks at its `audiences` as it looks at
  `permissions`.
- `docs/plugin-contract.md` gets a section on licences, the two formats and
  `present()`, `docs/backup-and-restore.md` says that a restore keeps the
  licence and the instance key and an import does not, and GLOSSARY.md gets
  the instance licence, the instance key, entitlement and dormant.
- The board enters a new file at each renewal. Billing a subscription monthly
  would mean twelve files a year, and that is an argument for billing per year
  until renewal can be fetched.
- Draft ADR 0036 in #411 becomes this record and should be dropped from that
  PR. Draft ADR 0036 in #410 can link here for the four things it needs, and
  presents with `present()` rather than sending the file.

## Revisit triggers

- **Renewal by hand becomes a burden**: an opt-in in the module, declared as one
  of its audiences, that fetches the next licence from the issuer. The core
  still verifies offline.
- **A module needs a limit inside its entitlement**, such as a monthly cap on
  AI requests: format version 2, and whether a cap belongs in the licence or in
  the service that bills it.
- **Digital signage adopts this licence** as its credential to the pairing
  service, instead of an account of its own.
- **A second vendor issues licences**: whether the licence screen needs to
  group by issuer, and whether the catalog should vouch for an issuer's keys
  beyond checking them against `issuer.url`.
- **Copied licences show up in the services' logs** in numbers that matter:
  what binding could be stronger without breaking restore and moves.
