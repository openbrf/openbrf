---
"@openbrf/web": patch
"@openbrf/shared": patch
"@openbrf/api": patch
"@openbrf/i18n": patch
---

Changing a password to one longer than the 128 characters signing in accepts now says the new password is too long, where before it said the current password did not match. The password forms stop at 128 characters, and first-boot setup refuses a longer administrator password instead of storing one that could never sign in. The limit is shared as `MAX_PASSWORD_LENGTH` in `@openbrf/shared` and set on the sign-in library.
