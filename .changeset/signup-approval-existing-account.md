---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Approving a sign-up request whose email address already has an account said the request could not be decided and to try again, and every retry failed the same way. The queue now says that the address already has an account and that the request should be rejected, since the person can already sign in.
