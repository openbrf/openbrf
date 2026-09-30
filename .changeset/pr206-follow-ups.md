---
"@openbrf/api": patch
"@openbrf/i18n": patch
---

Wait for sign-in links still being sent when the application shuts down, for up
to ten seconds, so a restart does not drop a link whose request was already
answered.

An approved sign-up request whose invitation fails for a reason other than the
mail not leaving (a fault in the application or the database) is now logged as
an error and raised, instead of being reported as "invitation not sent". The
approval itself stands.

The security headers are registered where the application is built, so the
integration suites see the headers a running instance sends. The message shown
when a connected app's return address is refused now says it may be not allowed
as well as incomplete.
