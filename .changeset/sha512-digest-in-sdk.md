---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
---

Export `parseSha512`, `formatSha512` and `IntegrityError` from the plugin SDK.

The instance reads a catalog entry's sha512 digest with them, so the catalog's
own check can accept exactly the spellings the instance accepts, instead of a
copy that drifts. The SDK reads a digest into a `Uint8Array` without `Buffer`
or `node:crypto`, so it still bundles into the browser, where neither exists.
Hashing and the constant-time comparison stay in the API.
