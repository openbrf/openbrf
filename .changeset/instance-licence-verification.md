---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": patch
"@openbrf/i18n": minor
---

Verify a licence for a paid plugin on the instance, offline (ADR 0042). Each
instance now has an id and an Ed25519 instance key, created at first start,
with the private key encrypted under the field-encryption key. An operator
enters a licence file with `openbrf licence add`, or the board through
`/api/licences`, and the host checks it against the keys the plugin's manifest
declares in its new `licence` field, and the instance's own id and key, on the
association's calendar day. A licensed plugin reads the result through
`host.entitlements`: active, or absent, expired, version not covered, wrong
instance, tampered or not yet valid, and can present the licence to its
issuer's service with the instance's signature. Nothing in the core depends on
a licence, and entering, verifying and removing one is written to the audit
log. After the instance key leaked, an operator replaces it with
`openbrf licence replace-key "<reason>" [--new-id]`, which is audited and leaves
every licence issued to the old key wrong-instance until it is reissued. The
SDK adds `createTestEntitlements` for a plugin's own tests.
