---
"@openbrf/tokens": minor
"@openbrf/theme-tools": minor
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

Control borders in the default theme now meet WCAG 1.4.11. `border-strong`,
which the contract gives to control borders and input outlines, was `#B8B5AC`
in light mode (1.75:1 on `surface-page`, 2.05:1 on `surface-raised`) and
`#4A4B50` in dark mode (2.04:1 and 1.83:1). It is now `#817F7B` (3.41:1 and
4.00:1) and `#747476` (3.81:1 and 3.41:1). Inputs, buttons and checkboxes
across the application draw a visibly firmer outline, and so do the
underlines, rules and quote bars that also use the token.

The contrast matrix measures `border-strong` on `surface-page` and on
`surface-raised` at 3:1, the new `NON_TEXT_CONTRAST_RATIO`, while text pairs
stay at 4.5:1. A `ContrastPair` may state the ratio it is held to in
`required`; one that leaves it out is held to `AA_CONTRAST_RATIO`. The theme
lint refuses a theme whose `border-strong` falls below 3:1 on either surface,
so a theme that passed before can now be refused: one that sets its own
surfaces and keeps an inherited or faint `border-strong`, or one with no
`border-strong` at all, whose value then falls back to `border-subtle`. A
theme that only extends the default theme and leaves its surfaces alone
inherits the new values and passes. A theme already installed stays
installed and can still be activated, since activation checks only the
statutory pairs.

`primaryColorOverride` now refuses an association's colour only for the pairs
that colour breaks. A pair the theme already fails, such as a `border-strong`
in a theme installed before this check, no longer drops the association's
colour from the application and the website.
