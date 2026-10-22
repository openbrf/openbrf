---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/i18n": minor
"@openbrf/web": minor
---

Hold a paid plugin's licence issuer and keys to the board's consent at start
(ADR 0042).

The instance now records the issuer and the fingerprint of each issuer key the
board was shown when it installed a paid plugin. At start it refuses a version
that declares a key outside those, as `licence-widened`, and a version that
names another issuer or no longer declares a consented key, with the new
finding `licence-issuer-changed`. Such a package could otherwise read another
issuer's licence for the same entitlement. The plugin loads again once the
board installs it again from the catalog. A key rotation passes in two
updates the board consents to: one that adds the new key, and one that drops
the old.

A licensed plugin installed before this release has no recorded consent to its
issuer's keys and is refused as `licence-widened` until it is installed again
from the catalog.
