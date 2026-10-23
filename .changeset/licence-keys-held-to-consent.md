---
"@openbrf/api": patch
---

Verify a licence only with an issuer key the board consented to (ADR 0042).

The licence screen and `openbrf licence` now try a licence only against the
keys whose fingerprint the plugin's consent records, in a declaration of the
consented entitlement and issuer, and read that consent each time. Before, the
server tried the keys of every manifest its last start kept, so after the board
consented to an update with other keys, or removed the plugin, the old key still
verified a licence until the next start: the screen showed it as verified, and
the audit log recorded it as verified with that issuer. Such a key now verifies
nothing, a licence entered with it stays not yet checked, and a licence it
verified earlier shows its issuer as not installed.
