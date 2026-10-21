# ADR 0037: Declared outbound hosts and secret settings

Date: 2026-10-19

## Status

Proposed. A stub. Its context comes from gap G2 in
[the AI package gap audit](../ai-package-gap-audit.md#g2-declared-outbound-hosts-and-a-secret-setting).
Its decision is written with the change that makes it. The broker package's
gap audit (#407) asks for the same two things, as its G6 and G10. This ADR
should answer for both rather than be written twice.

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
   catalog index version (draft ADR 0030 in #404 introduces version 2)?
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
   [ADR 0004](0004-encryption-key-provisioning.md) provisions it? Draft ADR 0033
   argues against encrypting a plugin's records, because the plugin runs in the
   same process as the key. The decision has to say what encryption protects
   against here: a database dump or a backup taken without the key, and not the
   plugin itself.

## Constraints already fixed

- A secret never reaches the audit log, an export or the browser.
- The recipient question stays the board's to answer
  (`docs/plugin-contract.md:232-237`). A declaration informs it and cannot
  answer it.
