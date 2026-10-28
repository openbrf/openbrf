---
"@openbrf/api": minor
---

An instance now reads the curated catalog at its version 3 address,
`https://raw.githubusercontent.com/openbrf/catalog/main/catalog-v3.json`, where
it used to read `catalog-v2.json`. Version 3 carries each plugin's resident
routes, with the curator's title for each, so the consent screen can show them
before anything is downloaded; version 2 cannot list a plugin that declares
them. An instance with `OPENBRF_CATALOG_URL` empty needs no configuration
change. An instance that wrote the version 2 address into `OPENBRF_CATALOG_URL`
now has an address that is not the curated one: it is refused unless
`OPENBRF_UNCURATED_PLUGINS_ENABLED` is set, so empty the variable.
