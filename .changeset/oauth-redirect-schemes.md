---
"@openbrf/api": patch
"@openbrf/web": patch
---

Accept only https redirect URIs for a hand-registered connected app, or plain
http on a loopback host for an app on the member's own machine, with no
credentials or fragment in them. The consent screen sends the browser back to
an app only at a web address. An app on the member's own machine is registered
with the provider as a native app, which is the only kind it accepts a loopback
address for; that changes only how the addresses are checked, and the member is
still asked before the app can act. An address the provider itself refuses,
such as an https address on this machine, now answers 400 with the reason the
registration form has a sentence for, where it used to answer 500.
