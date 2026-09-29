---
"@openbrf/api": patch
"@openbrf/web": patch
---

Accept only https redirect URIs for a hand-registered connected app, or plain
http on a loopback host for an app on the member's own machine, with no
credentials or fragment in them. The consent screen sends the browser back to
an app only at a web address.
