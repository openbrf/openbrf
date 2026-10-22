---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/i18n": minor
"@openbrf/web": minor
---

Hold a paid plugin's licence issuer and keys to the board's consent at start
(ADR 0042).

The instance now records the issuer and the fingerprint of each issuer key of
the catalog entry the board installed a paid plugin from. At start it refuses a
version that declares a key outside those, as `licence-widened`, and a version
that names another issuer or no longer declares a consented key, with the new
finding `licence-issuer-changed`. Such a package could otherwise read another
issuer's licence for the same entitlement. The plugin loads again once the
board installs it again from the catalog. The gate refuses only a package that
disagrees with the catalog entry installed, so a rotation the catalog publishes
in one release, which the board installs, passes. A package refused over its
issuer or keys keeps no manifest, even if it is also disabled or refused for another reason, so its keys verify no licence, on the
licence screen or from the command line.
