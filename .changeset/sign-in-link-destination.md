---
"@openbrf/web": patch
---

A sign-in link sent by email always landed on the start of the application. A member connecting an app through the sign-in screen was not taken on to the consent screen, so the app waited until it gave up, and anyone sent to sign in from a deep link lost it. The link now lands on the consent screen when an app is waiting, otherwise on the address that was asked for, and only otherwise on the start.
