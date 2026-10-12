---
"@openbrf/api": patch
---

Add `OPENBRF_OAUTH_CLIENT_METADATA_HOSTS`, an optional list of the hosts a
connected app may identify itself from by its metadata document. Empty, the
default, any public https host may, as before.
