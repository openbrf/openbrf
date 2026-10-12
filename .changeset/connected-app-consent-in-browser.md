---
"@openbrf/web": patch
---

Connecting an app in a browser works again. Pressing "Connect the app" on the
consent screen always ended in "The app's request was altered on its way here
and cannot be trusted", and no app could be connected. When the application
loaded, it rewrote the address bar and changed the signed authorization request
the screen then passed on. The address bar now keeps the request as the instance
wrote it, so the sign-in and consent screens pass it on unchanged, also after
either screen is reloaded. A request that really was altered on the way is
still refused.
