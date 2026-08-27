# The Open BRF token contract

This is the public styling API. Themes are written against it, and plugin UIs
style themselves with it. It is versioned with semver, independently of the
application.

**Contract version: 1.0.0**

## What a theme is

A theme is **pure data**: a manifest, two token sets (light and dark), font
files, a logo, and a choice of core-maintained view variants. It contains no
JavaScript. That is a deliberate limit, not an oversight: a theme needs no code
execution, so it gets none, which means installing one carries no supply-chain
risk and needs no security review. If you want to replace a whole view with your
own components, that is a UI plugin, not a theme, and it lives under the plugin
rules instead.

Because a theme is data, installing or switching one needs no restart.

## The rules

1. **Names describe roles, not colours.** `--obrf-accent-trust` is the accent for
   positions of trust. It is brass in the default theme; it can be anything in
   yours.
2. **Meanings are platform law.** A theme changes what `--obrf-status-warn`
   looks like. It can never change what it means. Colour carries legal semantics
   in a statutory register, so this is fixed.
3. **Everything visual flows through a token.** A hardcoded colour in a
   component is a defect. If a theme cannot restyle it, it is broken.
4. **Adding a token is a minor version** and always ships a fallback derived
   from an existing token, so a theme written against an earlier minor keeps
   working untouched. **Renaming or removing one is a major version** with a
   migration note.
5. **Accessibility is a hard gate, not advice.** See below.

## Accessibility

Every theme is checked at install time against a contrast matrix. Pairs
involving the register surface are **statutory**: a failure blocks installation
outright. The member register and the apartment register are documents an
association is legally required to produce and read, so no theme may render them
illegible.

The bar is WCAG AA, 4.5:1, and it applies even to 13px text.

The default theme is held to its own gate by a test, so the palette and this
document cannot drift apart.

## Tokens

Names below are written without the `--obrf-` prefix for brevity; in CSS every
token carries it.

### Surfaces and text, in the room

| Token            | Role                                             |
| ---------------- | ------------------------------------------------ |
| `surface-page`   | Page background                                  |
| `surface-raised` | Cards and panels                                 |
| `surface-sunken` | Table heads, inset areas                         |
| `text-primary`   | Body and heading text                            |
| `text-secondary` | Metadata and de-emphasised text; still passes AA |
| `border-subtle`  | Dividers and hairlines                           |
| `border-strong`  | Control borders, input outlines                  |

### The register surface

The statutory register renders on its own surface family so it reads as a
register rather than as another table. In the default theme this is a dark
board; a theme may make it light, but it stays distinct.

| Token                     | Role                              |
| ------------------------- | --------------------------------- |
| `surface-register`        | The surface carrying the register |
| `surface-register-raised` | Header and floor group rows       |
| `text-register`           | Primary text on the register      |
| `text-register-secondary` | Secondary text; still passes AA   |
| `border-register`         | Row dividers                      |

### The trust accent

Reserved for positions of trust, trust actions, active selection, links and
focus rings. It is not a decoration and must not be used as one.

| Token                   | Role                                             |
| ----------------------- | ------------------------------------------------ |
| `accent-trust`          | The accent itself                                |
| `accent-trust-hover`    | Hover state                                      |
| `accent-trust-soft`     | Tinted background carrying the accent            |
| `accent-trust-register` | The accent as used ON the register, for contrast |
| `on-accent-trust`       | Text and icons on an accent ground               |

### Status: colour as law

Each of these means exactly one thing, everywhere.

| Token                  | Fixed meaning                    |
| ---------------------- | -------------------------------- |
| `status-ok`            | Confirmed                        |
| `status-warn`          | Protected personal data, caution |
| `status-danger`        | Destructive actions, failures    |
| `status-info`          | Neutral information              |
| `status-*-soft`        | Tinted background for that state |
| `status-warn-register` | Caution as used ON the register  |
| `on-status-danger`     | Text on a danger ground          |

Colour is never the only signal. Core components pair every state with a label
and a pattern, so the meaning survives for a viewer who cannot distinguish the
hue. A theme cannot switch that off.

### Form, motion and type

| Token             | Role                                            |
| ----------------- | ----------------------------------------------- |
| `radius-control`  | Buttons, inputs, chips                          |
| `radius-panel`    | Cards and panels                                |
| `shadow-raised`   | The single elevation level; may be none         |
| `motion-duration` | State transition duration                       |
| `motion-easing`   | State transition easing                         |
| `font-ui`         | Interface and body face                         |
| `font-data`       | Monospace face for register data; columns align |

## Inheritance

A theme may declare `extends` and inherit from any installed theme, stating only
what it changes. The default theme is always inheritable. A missing value falls
back through the contract's own derivation chain, so stating `status-warn` alone
still yields `status-warn-soft` and `status-warn-register`.

## Fonts

Themes bundle their font files and declare each licence. **No external font
CDN**: loading fonts from a third party leaks every viewer's IP address to it,
which is a GDPR problem in the EU. The core self-hosts its own faces for the
same reason.

## What is themeable, and what is not

**Themeable:** colours, fonts, shape (radii and shadow), motion, the logo, and
the choice among core-maintained view variants.

**Not themeable:** the meanings of the status colours, the requirement that
state is labelled as well as coloured, and the accessibility floor. These are
platform rules.

Note that "no pills" is a rule of the _default theme_, not of the platform. Your
theme may use them.
