# ADR 0037: Declared outbound hosts and secret settings

Date: 2026-10-19

## Status

Accepted. Closes gap G2 in
[the AI package gap audit](../ai-package-gap-audit.md#g2-declared-outbound-hosts-and-a-secret-setting),
and answers the broker package's G6 and G10 (#407) as well, so the two modules
build on one design. The catalog check that compares the new field follows in
its own change (see "Not in this change").

## Context

**Where a plugin connects to.** The AI package sends the association's text to
a model provider. The board consents to a plugin before it runs, but the
manifest cannot say where the plugin sends anything:

- The manifest has no field for it (`packages/plugin-sdk/src/manifest.ts:191-232`),
  and neither has the catalog entry the consent screen reads before download
  (`packages/plugin-sdk/src/catalog.ts:119-153`).
- So the consent screen asks the board where the plugin sends personal data,
  with no answer chosen in advance (`docs/plugin-contract.md:193-247`,
  `apps/web/src/plugins/RecipientQuestion.tsx:20-24`).

A plugin runs at full process privilege, and its permissions are not a security
boundary (`packages/plugin-sdk/src/permissions.ts:4-11`). A declared host is
therefore consent text unless the host offers the way out and the catalog review
checks that the plugin uses nothing else. The core already has one rule for the
addresses a connection may reach (`apps/api/src/network/outbound-address.ts`).

**A secret in the settings.** The association's own provider key is entered in
the plugin's settings. Today that key:

- can only be a `text` field (`packages/plugin-sdk/src/settings-schema.ts:71-76`);
- is stored as plain JSON (`apps/api/prisma/schema.prisma:2246-2247`);
- is returned to the browser by `GET /api/plugins/:id/settings`
  (`apps/api/src/plugins/plugins.controller.ts:234-237`,
  `apps/api/src/plugins/plugin-admin.service.ts:914-931`);
- is already kept out of the settings audit entry
  (`apps/api/src/plugins/plugin-admin.service.ts:958-959`).

## Questions the decision must answer

1. **The manifest field.** Is it hosts, or recipients with a purpose and the
   personal-data categories each receives (as #407's G6 proposes)? Is it
   `https` origins only? Is it repeated in the catalog entry, and in which
   catalog index version (ADR 0030 introduces version 2)?
2. **The consent screen.** It shows the declared hosts and pre-fills the
   recipient question from them. The board still classifies each recipient as a
   processor or an independent controller.
3. **Republishing.** A republished version that adds a host is held as a
   widening, as one that adds a permission is.
4. **The way out.** Does the host offer the only sanctioned path, applying the
   outbound address rules and refusing an undeclared origin? Does the catalog
   review then check that a listed plugin uses nothing else?
5. **The secret field.** A `secret` field type should be:
   - write-only through the API, with the screen showing whether it is set;
   - replaced or cleared, never read back;
   - returned in clear only by `host.settings.read()` on the server.
6. **Encryption at rest.** Should a secret use the field encryption of
   [ADR 0002](0002-field-encryption-and-blind-indexes.md), keyed as
   [ADR 0004](0004-encryption-key-provisioning.md) provisions it? ADR 0033
   argues against encrypting a plugin's records, because the plugin runs in the
   same process as the key. The decision has to say what encryption protects
   against here: a database dump or a backup taken without the key, and not the
   plugin itself.

## Constraints already fixed

- A secret never reaches the audit log, an export or the browser.
- The recipient question stays the board's to answer
  (`docs/plugin-contract.md:232-237`). A declaration informs it and cannot
  answer it.

## Decision

### Recipients in the manifest

A plugin declares every place outside the instance it connects to, as
`recipients`:

```jsonc
{
  "openbrf": {
    "personalData": ["freeText"],
    "recipients": [
      {
        "id": "model-provider",
        "origin": "https://api.anthropic.com",
        "purpose": { "sv": "...", "en": "..." },
        "personalData": ["freeText"],
      },
    ],
  },
}
```

Recipients rather than bare hosts (question 1), because the board's question
is who receives what, and a host alone answers half of it. Each has:

- an `id`, unique in the manifest, so the consent snapshot can name it;
- an `origin`: `https` only, written as the WHATWG parser writes an origin
  (lowercase, no path, no trailing slash, no credentials, port only when not
  443), so one party has one spelling and two declarations of it are refused;
- a `purpose` in Swedish and English, inline rather than a locale key, for the
  reason ADR 0035 writes the processing purpose inline: the consent screen shows
  it before the package and its locale files are on the instance;
- the `personalData` it receives, from the shared categories (`PLUGIN_PERSONAL_DATA_CATEGORIES`,
  #415) and a subset of the plugin's own `personalData`, so the record of
  processing activities hears of every category a recipient receives. Empty is
  allowed: a connection that carries no personal data is declared all the same,
  because the board is shown every place the plugin connects to.

At most eight. The field is repeated in the catalog entry, read strictly, and
is a field version 1 of the index does not define, so it is in **index version
2** (ADR 0030). An instance reads versions 1 and 2; an index of version 1 that
carries the field, even empty, is refused.

### On the consent screen

The screen lists each declared recipient by its host, with its purpose in the board's
language and the categories it receives (question 2). Where one receives
personal data, the question about where the plugin sends personal data starts
with "yes" chosen and the hosts in the recipient field. The classification -
processor or independent controller - is never chosen: it is the board's call
and the declaration cannot make it, so nothing installs until the board has
made it. Where no declared recipient receives personal data, or none is
declared, the question is asked with no answer chosen, as before: a "no" on the
plugin's word alone would put "passes no personal data on" into the record on
the strength of a click.

The install request echoes the declared recipients with the rest of the declaration and
is refused when they no longer match the catalog. The command-line tool prints
them before it acts and echoes them too. The audit entry for the install names
the origins.

### Republishing

The consented declared recipients are stored on the installation as canonical strings -
id, origin and sorted categories - and the loader compares an installed
manifest against them as it compares the actions (question 3). A declared
recipient that is new, has moved to another origin, or receives one more
category is reported as `recipients-widened` and the plugin does not load until
the board consents again; one that receives fewer categories is within the
consent and loads. The purpose is not compared: it is the plugin's wording, shown
on the next consent, and not its reach.

### In the record of processing activities

The plugin's row in the record of processing activities lists, as its
recipients, the hosts of the declared recipients that receive personal data. A
recipient that receives none is not a recipient in the sense of art. 4(9), and
the record lists who receives personal data, not every place the plugin
connects to.

### The way out

A declaration constrains a plugin only if something holds the plugin to it
(question 4). The host offers the sanctioned way out:
`host.recipients.fetch(id, path, init)`, which reaches the declared origin and
nothing else, applies the instance's outbound address rules
(`apps/api/src/network/outbound-address.ts`), refuses a redirect to another
origin, and for a declared recipient that receives personal data carries the broker
package's per-person audit (its G6).

A request whose body carries personal data names the categories and the persons
it is about. Categories outside its declaration, and a person the
host would not hand the plugin (protected personal data, a restriction of
processing, an id the register does not hold), are refused before anything is
written or sent. Then one entry per person, with the declared recipient, the categories
and the body's SHA-256 digest, is committed before the request leaves, and one
with the outcome after it settles. Two entries rather than one updated, because
the audit log is append-only; both reach the person's access report. A
disclosure that names nobody, such as text a board member typed, is recorded
once with no person.

The catalog's listing rules carry the other half: a listed plugin connects to
nothing outside the instance it does not declare, sends personal data through
this path and no other, and the person reading its server bundle before the
listing is merged checks it. The catalog's own check does not compare the
entry's `recipients` with the package's yet, as it does the actions; that is
deferred (see "Not in this change"). Until it does, what holds a package to its
recipients on an instance is the consent snapshot checked at boot
(`recipients-widened`).

### Secret settings

A settings field of type `secret` (question 5) is:

- **write-only through the API.** `GET /api/plugins/:id/settings` returns
  `secretsSet`, the keys that hold a value, and never a value. A save carries
  `secrets` beside `values`: a string replaces, `null` removes, and a key left
  out is kept, which is how a form that never held the value saves. A required
  secret is satisfied by a stored value, and a save that would leave it unset is
  refused;
- **stored apart and encrypted** (question 6), one row per field in
  `plugin_secret_setting`, as field `pluginSecretSetting.value` of ADR 0002's
  field encryption under the key ADR 0004 provisions, with the plugin id and the
  key bound in as associated data. A ciphertext copied to another plugin's row or
  another field does not decrypt. One row per field, so a plugin rotating a token
  and a board saving the form cannot overwrite each other. Deleted with the
  installation;
- **in clear only on the server**, in what `host.settings.read()` returns;
- **writable by the plugin for its own secret fields**, through
  `host.settings.writeSecret(key, value)`, for a credential the far end replaces
  on every use, such as an OAuth refresh token (the finances plugin of #418
  needs this for Fortnox and Visma). Any other key is refused;
- **audited by key**, as `PLUGIN_SETTINGS_CHANGED` naming the field, on `WEB`
  with the board member for a save and on `PLUGIN` with no actor for the
  plugin's own write;
- **never defaulted and never empty**, and never in a website block's settings,
  whose values are published with the page.

What the encryption protects against, which ADR 0033 asks to be said: a
database dump or a backup read without the instance's key. It does not protect
a secret from the plugin it belongs to, which receives it in clear and runs in
the same process as the key. That is the same line the core's own credentials
are held to: the SMTP password and the SMS gateway token are encrypted for the
dump, not against the process that sends mail.

A field an upgrade turns from `text` into `secret` is read as unset until the
board enters it again; its plain copy is never read and is removed from the
stored settings when the new version's manifest loads at the next start, with an
entry in the audit log that names the field and not its value. A secret field an upgrade removes is let go at the next save.

## Not in this change

- **The catalog's check** comparing `recipients`, and the catalog serving index
  version 2 beside version 1 at the address an instance that reads version 2
  has built in. Until it does, the built-in address stays the version 1 index
  and no listed entry declares recipients.

## Consequences

- The AI package can declare its model provider, and the board installs it
  having read where the association's text goes and classified the provider.
- The association's own provider key, and the finances plugin's OAuth tokens,
  are entered once, never shown again, and are ciphertext in every dump.
- A plugin that sends personal data somewhere new needs the board's consent
  again, as one that asks for a new permission does.
- A plugin built for index version 2 is not offered to an instance that reads
  only version 1. That is the price of reading the index strictly, which is
  what keeps a consent screen from showing less than the entry says.
