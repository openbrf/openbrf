---
"@openbrf/web": patch
---

Connecting an app in a browser works again. Pressing "Koppla appen" on the
consent screen always ended in "the app's request has been altered on the way
here", and no app could be connected. When the application loaded, it rewrote
the address bar and changed the signed authorization request the screen then
passed on. The sign-in and consent screens now read the request as the page was
loaded with it. A request that really was altered on the way is still refused.
