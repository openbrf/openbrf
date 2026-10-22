---
"@openbrf/api": minor
---

An instance now reads the curated catalog at its version 2 address,
`https://raw.githubusercontent.com/openbrf/catalog/main/catalog-v2.json`, where
it used to read `catalog.json`. Version 2 lists the plugins and themes that need
the fields added in index version 2, which an instance that reads version 1
could not offer. An instance with `OPENBRF_CATALOG_URL` empty needs no
configuration change. An instance that wrote the old curated address into
`OPENBRF_CATALOG_URL` now has an address that is not the curated one: it is
refused unless `OPENBRF_UNCURATED_PLUGINS_ENABLED` is set, so empty the variable.
