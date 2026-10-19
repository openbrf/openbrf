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
  "issuer": "Apteo AB",
  "issuedOn": "2026-11-02",
  "instanceId": "4f1d2a9e-7c3b-4b6e-8f0a-1d2c3b4a5e6f",
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
  name is the issuer's to choose. Apteo names each one after the plugin id that
  reads it, except where a module is several plugins.
- **Two optional dates per entitlement**, each a calendar date read on the
  association's calendar day ([ADR 0013](0013-the-association-s-calendar-day.md))
  and inclusive. `validUntil` is the last day the module may be used, and
  without it, use has no end. `updatesUntil` is the last release date the
  entitlement covers, and without it every release is covered. A licence sold
  once with twelve months of updates carries only `updatesUntil`. A
  subscription carries only `validUntil`.
- **No personal data.** It names the association and the instance, never a
  contact person, a signatory or an email address. An organisation number of an
  economic association names a legal person. Presenting the licence to its
  issuer therefore sends nothing the consent screen has to ask about, and the
  licence is outside [ADR 0019](0019-every-column-that-names-a-person-is-answered-for.md).
- **Strict.** Version 1 refuses a field it does not know, at either level. A
  field that narrows what an entitlement allows, such as a usage cap, would
  otherwise be ignored by an older core. Adding one is version 2.

Ed25519 rather than RSA or ECDSA: short keys and signatures, deterministic
signing, and no parameters to get wrong. Our own envelope rather than JWS: a
JWS verifier has to refuse every algorithm but one, and this envelope has no
algorithm field to refuse.

### The instance gets an identity, and the licence is bound to it

Each instance gets an **instance id**: a random UUID that the core creates once
(in the migration that adds it, for instances that already exist, or at first
start), keeps in the database and never changes. Nothing on any screen or
route writes it. The licence screen shows it, so the board can give it when it
orders a licence.

The licence binds to the instance id and to nothing else:

- **It follows the association's data, not the machine.** A backup restored on
  another host, a move to a hosted instance, or a new domain keeps the id and
  the licence with it. An instance set up afresh, with its data imported rather
  than restored, has a new id and needs its licence reissued.
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

A restored backup started beside the original carries the same id, so two
copies run on one licence. The terms forbid that and the code does not try to
stop it. Apteo's services see both, as described under
[Where enforcement is real](#where-enforcement-is-real).

### The core holds and verifies licences, and plugins read the result

**Entering a licence.** The board enters a licence file on the core's
**licence screen**, under the capability that installs plugins
(`association:manage`), or an operator enters one with the command-line tool.
The core keeps every licence entered until the board removes it, and writes
`LICENCE_ADDED` and `LICENCE_REMOVED` to the audit log with the licence id, the
issuer, the entitlement names and their dates. Nothing in the file is personal
data, so there is nothing to keep out of the log. A file that is not a
licence, or whose signature fails against a key an installed plugin declares,
is refused when entered and is not stored. One whose key no installed plugin
declares yet is stored and shown as not yet checked, so the board can enter
the licence before installing the module.

Several licences can stand side by side. An association that bought the
connector outright and later subscribes to the AI package holds two files.
When the subscription lapses, the connector's own file still covers it, and no
issuing rule has to merge the two.

**A plugin declares the licence it reads.** A licensed plugin's manifest names
one entitlement, the issuer it trusts and that issuer's public keys:

```jsonc
"licence": {
  "entitlement": "mcp-connector",
  "issuer": { "name": "Apteo AB", "url": "https://openbrf.se/licence" },
  "keys": { "apteo-2026-1": "<base64 Ed25519 public key>" },
},
"released": "2026-12-01",
```

`released` is the release date the release workflow writes into the manifest,
compared with `updatesUntil`. The keys sit with the plugin rather than in the
core, so the core holds no vendor's key and has no rule that is about Apteo.
Anyone who sells a plugin can issue licences for it in the same format. A
plugin that declares a key can only read licences that key signed, and a
licence carries nothing a plugin could misuse, so a plugin that declares Apteo's
key learns only what the licence screen shows anyone with `association:manage`.

**Who verifies: the host.** It verifies on read, against the plugin's declared
keys and the instance's own id, on the association's calendar day:

```ts
interface PluginEntitlements {
  /** The entitlement the manifest names, judged today. */
  get(): Promise<EntitlementState>;
  /** The signed licence that grants it, as entered, to present to its issuer. */
  document(): Promise<string | null>;
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
the most recently entered licence that names the entitlement. A licence that
names the entitlement under another instance id is `wrong-instance`. A
licence under one of the plugin's key ids whose signature fails is `tampered`.
`not-yet-valid` covers an `issuedOn` after today, which is a wrong clock on
one side or the other.

One verifier in the host, not one per plugin: one parser to get right and
test, one screen the board enters a licence on once, and the instance id and
calendar day, which only the core has, applied the same way everywhere.

**The document can be presented.** `document()` returns the licence the
active state rests on, so a plugin can present it to its issuer's service as
its credential: the theme pack service in #410, and later Apteo's AI gateway.
The board enters a licence once, never again in a plugin's settings.

**Before install, the board is told.** The catalog entry mirrors the manifest's
`licence` and `released`, as it mirrors `permissions`. The install screen and
the consent screen say that the module needs a licence from the named issuer
and does nothing without one. When an update would be released after the
installed licence's `updatesUntil`, the update screen says so before the board
updates and stops being covered.

### What stops when the licence is absent or lapses

Without an active entitlement, a module is **dormant**:

- **MCP Connector.** Its route stays mounted and answers every MCP request with
  an error that says the instance's licence for MCP Connector is absent or has
  lapsed, and when. It lists no tools and makes no calls. Its admin screen shows
  the state and where to get a licence.
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
  never reports a licence or its use to anybody.
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

A check in a plugin's code, in the core it runs on, or in the database row
holding the instance id can be removed or edited by whoever runs the instance.
Within the instance, this design stops honest mistakes: running a module
nobody bought, a licence copied from another instance, a forged or altered
file, an update the licence does not cover. It does not stop a determined
operator, and does not try to.

Where a module uses something Apteo hosts, that service takes the licence
document as its credential, verifies it with the same public key, and checks
the entitlement, the dates and a denylist of revoked licence ids: the theme
pack service (#410), Apteo's AI gateway when it exists, and digital signage's
pairing service if signage adopts this licence. These services see which
licences are in use from where, so two instances running on one licence become
visible there. They also hold the only revocation there is. An instance cannot
learn of a revoked licence without calling home, so on the instance a licence
ends only on its dates. That is one reason subscriptions are issued for the
period paid, not for a year ahead.

### Keys

Apteo's signing key never sits in a repository, in CI or on an instance. It is
held in Apteo's secret store and used by the issuing tool alone. Each key has a
`keyId`. A new key is declared in a plugin release before any licence is signed
with it, and a plugin declares at most two at once. If a key leaks, a release
drops it and every licence it signed is reissued under the next key. That is
the revocation offline verification allows, and it does not reach releases
already installed.

Issuing is a stub for now: a command in the modules' repository that builds a
payload, and signs it with the key from the secret store when an Apteo person
runs it. The test environment's licences come from that command and are
verified exactly as an association's would be, so the modules are tested with
the licence checks on. A plugin's own tests sign with a throwaway key generated
in the test, and the SDK offers a test double for `host.entitlements`.

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
- **Each plugin verifying its own licence.** Several parsers, several screens,
  and the board entering one licence once per module. The plugin also has
  neither the instance id nor the association's calendar day.
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

- The core gains an instance id, a table of entered licences, the licence screen
  and the CLI command, the audit entries, the manifest's `licence` and `released`
  fields and their catalog mirror, the install, consent and update screen
  notices, and `host.entitlements`. It is all general, and none of it names
  Apteo. Tests cover valid, absent, expired, not-yet-valid, wrong-instance,
  tampered and version-not-covered licences, an unknown key, a strict-schema
  refusal, two licences side by side, and the calendar-day boundary at
  `validUntil`. This is task C1 (APT-5784, APT-5746).
- `docs/plugin-contract.md` gets a section on licences and the format,
  `docs/backup-and-restore.md` says that a restore keeps the licence and an
  import does not, and GLOSSARY.md gets the instance licence, entitlement and
  dormant.
- The board enters a new file at each renewal. Billing a subscription monthly
  would mean twelve files a year, and that is an argument for billing per year
  until renewal can be fetched.
- A licence is a bearer document: whoever holds the file can present it to
  Apteo's services. It names no person and grants nothing on the instance
  that installed it, and the services' denylist and rate limits answer the
  rest.
- Draft ADR 0036 in #411 becomes this record and should be dropped from that
  PR. Draft ADR 0036 in #410 can link here for the four things it needs.

## Revisit triggers

- **Renewal by hand becomes a burden**: an opt-in in the module, declared as its
  outbound host, that fetches the next licence from the issuer. The core still
  verifies offline.
- **A module needs a limit inside its entitlement**, such as a monthly cap on
  AI requests: format version 2, and whether a cap belongs in the licence or in
  the service that bills it.
- **Digital signage adopts this licence** as its credential to the pairing
  service, instead of an account of its own.
- **A second vendor issues licences**: whether the licence screen needs to
  group by issuer, and whether the catalog should vouch for an issuer's keys.
- **Copied licences show up in the services' logs** in numbers that matter:
  what binding could be stronger without breaking restore and moves.
