---
"@openbrf/api": patch
"@openbrf/i18n": patch
---

Wait for sign-in links still being sent when the application shuts down, for up
to five seconds and before the database connection closes, so a restart does not
drop a link whose request was already answered. The HTTP server stops taking
requests first, so a sign-in request accepted as the shutdown begins is either
answered and delivered or refused, never answered and lost.

An approved account request whose invitation fails for a reason other than the
mail not leaving (a fault in the application or the database) is now logged as
an error rather than a warning. The board is still told that the person is in
the register and needs an invitation from the person's own view, because the
approval stands.

The security headers are registered where the application is built, so the
suites that build the application with `createApplication` see the headers a
running instance sends. The message shown when a connected app's return address
is refused now says it may be not allowed as well as incomplete.
