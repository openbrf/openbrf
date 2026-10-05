---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Refuse a catalog entry whose digest is not written as `sha512-<base64>` or 128
hex characters.

`parseCatalogIndex` now reads each artifact's `sha512` with the same
`parseSha512` an instance verifies a download with, so an index with a badly
spelled digest is refused whole, naming the field, instead of being accepted and
failing at install time. An index that parsed before and carries such a digest
no longer does.

An installation of a theme from an entry whose digest cannot be read is now
reported as a malformed checksum in the catalog, rather than as a package that
does not match its checksum, which suggested the download had been tampered with.
