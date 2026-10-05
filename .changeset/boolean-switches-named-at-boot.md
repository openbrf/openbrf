---
"@openbrf/api": patch
---

Refuse to start when a boolean setting is neither "true" nor "false".

`OPENBRF_ACTIONS_READ_ONLY`, `OPENBRF_PLUGINS_ENABLED`,
`OPENBRF_UNCURATED_PLUGINS_ENABLED`, `OPENBRF_PLUGINS_REINSTALL_ON_BOOT` and
`OPENBRF_S3_FORCE_PATH_STYLE` read any value other than the exact word `true` as
false, so `OPENBRF_ACTIONS_READ_ONLY=1` started an instance that still wrote,
without a word. They now take `true` or `false` in any case, an empty value
still means the default, and anything else stops the boot with the variable
named.
