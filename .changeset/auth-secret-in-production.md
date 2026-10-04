---
"@openbrf/api": minor
---

Refuse to start in production with a `BETTER_AUTH_SECRET` shorter than 32
characters or equal to the development placeholder, and say how to generate
one. `.env.production.example` now says the same.

**Upgrade note:** a production deploy whose secret is shorter than 32
characters, or is the placeholder, stops booting after this release until the
secret is replaced. Generate one (`openssl rand -base64 48`) and set it before
updating. A deploy whose secret already meets the rule needs nothing, and should
keep the secret it has: it does more than sign.

Replacing the secret:

- signs everybody out, because every session and sign-in link is signed with it;
- makes every enrolled second factor unusable, because the authenticator
  secrets and the recovery codes are encrypted with it. A member who enrolled
  one can no longer finish signing in, and there is no reset in the interface
  yet. Remove the second factors (`DELETE FROM auth_two_factor;` and
  `UPDATE auth_user SET "twoFactorEnabled" = false;`) and ask those members to
  enrol again;
- makes the secret of every connected app registered with one unreadable, so
  those apps can no longer sign in. Register each of them again, and give the
  app the new client id and secret.
