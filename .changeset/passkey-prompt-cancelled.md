---
"@openbrf/web": patch
---

Closing the browser's passkey prompt, or letting it time out, was reported as "signing in did not work" instead of saying that no passkey was used. The sign-in screen now tells the two apart. A network failure while starting a passkey sign-in no longer leaves the form stuck on "Signing in..." either.
