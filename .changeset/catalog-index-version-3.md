---
"@openbrf/api": minor
---

An instance now reads the curated catalog at its version 3 address,
`https://raw.githubusercontent.com/openbrf/catalog/main/catalog-v3.json`, where
it used to read `catalog-v2.json`. Version 3 lists the plugins that declare
resident routes, which an instance that reads version 2 could not offer. An
instance with `OPENBRF_CATALOG_URL` empty needs no configuration change. An
instance that wrote the version 2 curated address into `OPENBRF_CATALOG_URL` now
has an address that is not the curated one: it is refused unless
`OPENBRF_UNCURATED_PLUGINS_ENABLED` is set, so empty the variable.
