---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

Harden sign-in, connected apps and the register after the access-control
review:

- One rule decides where an authorization code may be sent, shared by client
  registration and the consent screen: https off this machine, plain http on a
  loopback host, or an app's own reverse-domain scheme. A client that
  identifies itself by its metadata document must keep its web redirect
  addresses on that document's origin.
- A connected app's token carries only the scopes the member's consent grants
  now.
- In production, a `BETTER_AUTH_SECRET` committed to the repository or with
  fewer than 8 different characters stops the instance from starting.
- A change sent with the session cookie in a form encoding is refused when it
  names no origin.
- An invitation to an address another account already signs in with is
  refused with its own message instead of failing at activation.
- An election may be dated at most five years back.
- A failure's logged stack keeps only lines shaped like call frames.
- Putting somebody into a group chat they are already in answers with the
  member list, whoever they are.
- The signup confirmation says that a later request from an address with one
  waiting is not kept.
