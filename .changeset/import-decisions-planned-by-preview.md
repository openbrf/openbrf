---
"@openbrf/api": patch
"@openbrf/web": patch
---

Starting a member list import after answering rows the preview could not
resolve no longer works out the whole file again inside the request. For a long
file with personal identity numbers, checked against a register that already
holds some, that took minutes and could outlast the proxy in front of the API.

The import now starts only with the answers its preview was worked out with,
and is refused with `decisions-not-previewed` otherwise. The import screen then
takes the preview again with the answers, in the background as any preview,
and starts the import as soon as it is ready if it shows the same rows. When
the answers change what other rows match, the screen shows the new preview
first, as before.
