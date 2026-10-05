---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

When the apartments at an address could not be read, a sign-up request's apartment list stayed empty, so the request could never be approved and nothing said why. The request now says the apartments could not be read and offers to try again. Changing a request's address also drops the apartment chosen at the previous address straight away, so Approve cannot send it while the new address's apartments are still loading.
