---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Compose a theme in the admin interface.

An administrator names a theme, chooses the theme it inherits from and changes
the colours they want changed. Everything they leave alone is inherited, so what
is saved is the handful of values they actually chose rather than a copy of the
theme they started from. Radius, shadow, motion and the typefaces are not part
of the form and are therefore inherited too; a composed theme bundles no fonts
and selects no view variant of its own.

The draft is applied to the composer's own browser through the same preview
mechanism the theme screen uses, so nobody else sees a half-finished theme and
nothing is written until it is saved. Contrast is measured in the browser while
the colours are chosen, and the screen says what that measurement is: advice.
The gate is the install lint on the server, which runs again on every save, so a
composed theme that renders the statutory register below WCAG AA is refused
exactly as a package from a catalog would be, with the same findings naming the
pair, the mode and the measured ratio.

A saved theme is an ordinary installed theme: it appears in the theme list, is
previewed, activated and removed through the routes that were already there, and
editing it composes it again at the next patch version, which recomputes what
any theme inheriting from it renders. Composing needs no catalog, which is what
makes it the answer for an association with nothing to install from. A theme
that came from a catalog is not editable here, because the next update from that
catalog would take the board's own values away again.
