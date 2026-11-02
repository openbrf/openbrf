---
"@openbrf/api": minor
---

The instance reads the curated catalog at its version 4 address,
`https://raw.githubusercontent.com/openbrf/catalog/main/catalog-v4.json`
(ADR 0053). Version 4 is the index that can list a plugin whose resident routes
serve people who do not live here, or that shows a person's name at their own
choice.

An instance with `OPENBRF_CATALOG_URL` empty needs no configuration change. An
instance that wrote the version 3 address, or an older one, into
`OPENBRF_CATALOG_URL` is not reading the curated catalog any more, so it refuses
that address unless `OPENBRF_UNCURATED_PLUGINS_ENABLED` is set. Empty the
variable.
