---
"@openbrf/api": patch
---

Verify a licence only with an issuer key the board consented to (ADR 0042).

The licence screen and `openbrf licence` now count a plugin only while its
consent record holds its licence declaration by the boot gate's test: the
consented entitlement and issuer, and each declared key among the consented
ones. They read that consent each time they list the licences, and again when
they store what a key verified, in the same transaction and under a lock that
an update or removal of the consent waits for. Before, the server tried the
keys of every manifest its last start kept, so after the board consented to an
update with other keys, or removed the plugin, the old key still verified a
licence until the next start: the screen showed it as verified, and the audit
log recorded it as verified with that issuer. Such a key now verifies nothing,
a licence entered with it stays not yet checked, a licence it verified earlier
shows its issuer as not installed, and the plugin is no longer listed with an
entitlement state on the licence screen.
