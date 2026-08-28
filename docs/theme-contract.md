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

Resolution happens in two steps, in this order. First the chain from the root
ancestor down to the theme itself is merged, so a value a theme states wins over
the same value in its parent. Then the fallback chain above fills whatever is
still missing.

The two modes inherit separately: a theme that changes only the light accent
keeps its parent's dark one.

A parent that is not installed, and a chain that loops, are both refused at
install time rather than resolved around. A theme cannot be removed while
another installed theme inherits from it.

## The package format

A theme is distributed as a gzipped tar archive holding regular files only, with
`theme.json` at its root. If every entry sits under one directory, that
directory is stripped, so it makes no difference whether the archive was rooted
at the theme's folder or not.

```json
{
  "name": "example-theme",
  "displayName": "Example",
  "version": "1.0.0",
  "contract": "^1.0.0",
  "extends": "porttavlan",
  "description": "One sentence about the theme.",
  "modes": {
    "light": { "accent-trust": "#2F5D50" },
    "dark": { "accent-trust": "#7FBFAA" }
  },
  "fonts": [
    {
      "family": "Spline Sans Mono",
      "license": "OFL-1.1",
      "licenseFile": "fonts/OFL.txt",
      "files": [{ "path": "fonts/mono.woff2", "weight": "400 700" }]
    }
  ],
  "logo": "logo.png",
  "viewVariants": { "memberRegister": "table" }
}
```

`name` is the theme's identity: lowercase words joined by hyphens, and unique in
the catalog. `porttavlan` is reserved for the default theme, which is built into
the core and never installed. `version` is a release version; a pre-release is
refused, because a theme published to a catalog is by definition published.

`contract` states which versions of this contract the theme was written against.
The supported range syntax is deliberately a subset of semver: `*`, an exact
version, `^`, `~`, `>`, `>=`, `<` and `<=`, joined by a space for AND and by `||`
for OR. A range outside that subset is refused rather than guessed at, because a
range the core cannot read is one it cannot honour.

Every path in the package is relative, has no parent segment and no backslash.
The file types a package may contain are `.json`, `.woff2`, `.woff`, `.ttf`,
`.otf`, `.png`, `.webp`, `.txt` and `.md`. Anything that could execute is
refused, SVG included: an SVG is a document that can carry script and external
references, and a theme's logo is served from the association's own origin.

### Fields accepted and ignored

`license`, `requires` and `recommends` are accepted and have no behaviour. There
is no licence validation and no dependency resolution: a theme declaring
`requires` installs exactly as if it had not. They are accepted so a theme
written against the fuller contract installs here unchanged, rather than the
format having to be forked the day dependency resolution ships.

Unknown top-level fields are ignored too, and reported as a warning so a
misspelled `extends` is still visible to the author. The same holds for token
names: a theme written against a later minor may state a token this core has
never heard of, and the contract's own minor-version rule says that must still
install, so the value is dropped and the name reported.

## View variants

A theme cannot ship components. What it can do is pick among layouts the core
maintains, which is what `viewVariants` selects:

| Slot             | Variants | Default |
| ---------------- | -------- | ------- |
| `memberRegister` | `table`  | `table` |

A slot or a variant the core does not maintain is refused at install time: an
unrecognised variant means the theme was built against a different core, and
installing it would render nothing. A slot the theme says nothing about renders
the default.

## Fonts

Themes bundle their font files and declare each licence. **No external font
CDN**: loading fonts from a third party leaks every viewer's IP address to it,
which is a GDPR problem in the EU. The core self-hosts its own faces for the
same reason.

Concretely, the install lint refuses a theme when a font source points anywhere
outside the package, when a declared file is missing from it, when a font file
in the package is not covered by a declaration, or when a declaration carries no
licence. Bundled files are served from the association's own instance.

## Installing

A theme is installed from a catalog: the entry names a tarball URL and its
sha512, the download is verified against that checksum before anything is
unpacked, the package is read and linted, and only then is it written to
`/data/themes` and recorded. A package whose manifest disagrees with the catalog
entry about its name or version is refused - the checksum proves the bytes are
the ones the catalog meant, not that they are what they claim to be.

Storage and the database cannot share a transaction, so the database is made the
decider. The package is written to a staging directory beside the installed
theme, the row and the audit entry are written in one transaction, and moving
the staged files into place is that transaction's last step. Anything that
refuses the install - a failed lint, a rejected write, a swap that cannot be
completed - therefore leaves the version already installed exactly as it was,
and a swap that fails part way puts the displaced version back before the
failure is reported. What no ordering closes without a distributed transaction
is a connection lost between the files moving and the transaction committing,
which leaves new files under the previous row until that theme is installed
again.

Removal is the same ordering read the other way. The row goes first, because the
row is what the instance reads: the theme list, the rendering and the allowlist
the asset route serves from are all built from it. Files that cannot be deleted
afterwards are unreferenced rather than half-installed, and a reinstall of that
id replaces them.

**No restart.** A theme carries no code, so there is nothing to load into the
running process: installing writes files and a row, activating writes one
column, and the browser applies a stylesheet.

A board member can preview an installed theme before activating it. The preview
is the same resolution activation would produce, applied to that one browser
session and to nothing else; nothing is written and no other viewer is affected.

## Writing a theme

`@openbrf/theme-tools` is the same package the core runs at install time:
`parseThemeManifest`, `lintTheme`, `resolveThemeChain` and the archive reader
and writer. A theme repository's CI can therefore run the exact check the core
will run, and see the same refusal, before the theme is published.

## What is themeable, and what is not

**Themeable:** colours, fonts, shape (radii and shadow), motion, the logo, and
the choice among core-maintained view variants.

**Not themeable:** the meanings of the status colours, the requirement that
state is labelled as well as coloured, and the accessibility floor. These are
platform rules.

Note that "no pills" is a rule of the _default theme_, not of the platform. Your
theme may use them.
