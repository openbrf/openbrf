# ADR 0036: Paid themes, delivered to a licensed instance by a plugin

Date: 2026-10-19

## Status

Accepted. Builds on the instance licence and `host.entitlements`, which are a
decision of their own and not yet recorded; what this one needs from them is
listed under [What this needs from the instance licence](#what-this-needs-from-the-instance-licence).

## Context

Premium themes are on the roadmap as one of Apteo's paid modules: a pack of
professionally designed themes a housing cooperative buys for its instance.
What is paid is the design work and the licence to use it, never the ability
to theme. The theme engine, light and dark, the default theme, the composer,
preview, inheritance and installing any theme from a catalog stay free, and so
does every tool an author needs to build an equivalent theme of their own.

Four facts about themes and the catalog decide how such a pack can reach an
instance:

- **A theme is pure data** ([the token contract](../theme-contract.md)). It has
  no code, and the install lint is its gate: the contrast matrix, with the
  register surface as a statutory pair that blocks the install, self-hosted
  fonts with a declared licence, and file types that cannot execute. Once
  installed, a theme is files on the instance's own volume, served from its own
  origin.
- **The catalog is public.** The curated index and every tarball it names are
  readable without a token ([ADR 0020](0020-the-public-catalog-and-the-published-packages.md)).
  A paid theme listed there would be free to every instance that reads it.
- **The core ignores a theme's `license` field.** It is accepted so a theme
  written against a fuller contract still installs, and has no behaviour.
- **A plugin cannot install a theme.** No permission grants it, the host object
  has no member for it, and a plugin that asks NestJS for the core's theme
  installer is refused at load with `forbidden-injection`. A theme reaches an
  instance from a catalog through the theme screen, or is composed on it.

Apteo's other paid modules have already settled how an instance is licensed.
The AI package and the MCP Connector plan one **instance licence**: a file
Apteo signs with an Ed25519 key, entered once on the instance, verified there
offline with no call home, and read by a plugin through a new host member,
`host.entitlements`. The plans for BankID and Freja sign-in and for document
signing use the same licence rather than one of their own. The digital signage
module enforces its entitlement in the pairing service Apteo hosts for it, which
is infrastructure that module needs anyway. None of them plans an online
licence service that issues keys or answers entitlement queries for other
modules. So there is one licence to reuse, and nothing to build a second one
beside.

A licence check in a plugin anyone can read is a check anyone can remove, and
for a data-only theme even that check would come too late: whoever holds the
package holds the theme. The one place a theme can be withheld from an
unlicensed instance is before it is delivered.

## Decision

### What is sold

A pack of themes, each an ordinary theme package under the token contract,
held to the same install lint as any other with no exemption for being paid.
The licence entitles an instance to download the pack and its updates for the
term the licence states.

### Delivery: a plugin fetches the pack from a service that checks the licence

The pack is not listed in the catalog. A paid plugin, **Premium themes**,
listed in the catalog like any other plugin and built only on the public plugin
API, delivers it:

1. The board enters the instance licence once, on the core's licence screen. The
   plugin reads through `host.entitlements` whether it carries the `themes`
   entitlement, and until it does the plugin offers nothing to install.
2. An administrator opens the plugin's screen and asks for the pack. The
   plugin's server, never the administrator's browser, calls the **theme pack
   service** Apteo hosts, presenting the licence. The service verifies the
   licence's signature with the same public key the instance uses, checks the
   entitlement and the term, and answers with the pack's index: per theme the
   id, version, contract range, sha512 and a download address.
3. The plugin downloads each package the administrator chose, and hands it to
   the core with its sha512 through `host.themes.install`, below. The core
   verifies, reads, lints and records it exactly as it would a catalog package.
4. The administrator previews and activates a theme on the core's theme screen,
   as they would any other.

The theme pack service holds no licence store of its own. It accepts the signed
instance licence as its credential, so the licence issued for the AI package
and the one that unlocks themes are one file with one more entitlement in it.
It logs downloads per licence, which is how an over-shared licence becomes
visible, and limits their rate.

The plugin's own code is public, as every catalog listing's is. Only the pack
is withheld.

### A plugin-callable theme install in the core

The core gains one general entry, open to any plugin author and with nothing
in it about Apteo or about a licence:

- A permission, **`themes:install`**, which the board consents to like any
  other, shown on the consent screen as letting the plugin install and update
  themes on the instance.
- A host member, **`host.themes.install(request, package, { sha512 })`**. It
  takes the request the plugin's own route is serving and installs as the
  person behind it, who must hold the capability the theme screen requires to
  install (`association:manage`), the same way `host.actions.invoke` dispatches
  as the caller of the request. A plugin's background job has no request, so it
  cannot install a theme: nothing changes what every resident sees without an
  administrator asking for it.
- The same admission path the catalog and the composer take: the digest checked
  before anything is unpacked, the package read and linted, the files staged,
  the row and the audit entry written in one transaction, under the same lock
  per theme id. A package the lint refuses is refused here with the same
  findings, and the install the instance already had stays as it was.
- The row records a third source beside a catalog entry and a composed theme:
  the plugin that installed it. A plugin may install over a theme it installed
  itself, and not over one from the catalog, one composed on the instance, or
  one another plugin installed; a catalog install is likewise refused over a
  theme a plugin installed. The audit entry names the plugin and the person.
- It installs and nothing else. Activating stays on the theme screen, and so
  does uninstalling. A plugin may also list the themes it installed, with their
  versions, so it can offer an update; it cannot read or change any other.

That the install lint, not the source, is the theme gate is what makes it safe
to give this to a plugin. A theme from a plugin cannot do anything a theme from
the catalog cannot do, and a curated instance still runs only plugins the
curated catalog lists, with the board's consent to each one's `themes:install`.

### When the licence lapses, or the plugin is removed

Nothing that is installed is taken away. A lapsed licence stops new downloads
and updates; the themes already installed stay installed and activatable, and
the active one stays active. Removing the plugin leaves its themes in place,
recorded as installed by a plugin no longer present, and the board can still
uninstall them on the theme screen, subject to the usual rule that a theme
another inherits from cannot be removed. An instance that never had a licence
works exactly as it does without the plugin.

This follows the free tier's rule that nothing is retracted, and it is the
honest position for data: a theme on the volume can be copied whatever the
core does. What the licence buys is the pack and its updates, not secrecy.

### What this needs from the instance licence

The instance licence is decided separately. Premium themes rely on it for four
things, and that decision should provide them:

- An entitlement per module, so a licence can carry `themes` beside the others.
- A way for a plugin to present the licence to its issuer: the signed document
  itself, or a proof derived from it, readable through `host.entitlements`.
  Without it the board would enter the same licence twice, once on the core's
  screen and once in the plugin's settings.
- No personal data in the licence. It names the housing cooperative and the
  instance, not a contact person, so presenting it sends none, and the plugin
  answers the consent screen's question about personal data leaving the
  instance with no.
- A term the plugin can read, so its screen can say until when updates are
  included.

## Alternatives rejected

- **Listing the pack in the public catalog and selling only the licence
  terms.** Nothing would separate a paying instance from any other, so the
  module would have no paid side.
- **A private catalog behind `OPENBRF_CATALOG_TOKEN`.** A curated instance
  reads only the curated index, and pointing an instance at another index opts
  it out of curation for plugins too. A licence should not cost an association
  the curation guarantee.
- **Shipping the pack inside the plugin's tarball.** A catalog artifact is a
  public release asset, so this is the public catalog again.
- **The core validating a theme's `license` field.** The core cannot tell a
  genuine licence from a copied one without calling a vendor, it would be the
  first vendor-specific rule in the theme path, and it would protect nothing:
  the files would already be on the volume.
- **A plugin registering itself as a theme source on the theme screen.** It
  would put the pack beside the catalog's themes, but it makes the theme
  screen call plugin code to list and download, mixes a source the board
  consented to as a plugin into one that is curated, and is a larger API than
  one install entry. Worth reconsidering if more than one vendor sells themes.
- **Reaching the installer through a core action.** An action takes JSON a
  connected app can send; a package is bytes, and installing packages is kept
  out of reach of connected apps and the AI package.
- **A licence service for themes alone.** The instance licence exists for the
  other paid modules; a second one would be a second key to keep, a second
  thing for the board to enter and a second place to get revocation wrong.

## Consequences

- The core change is general: a permission, a host member and a third source
  on the theme row, with tests for the lint refusing through it, the source
  rules, and the capability of the person behind the request. Any author can
  build a plugin that installs themes, paid or not.
- The theme pack service is Apteo infrastructure: a small endpoint, its
  storage for the packages, and the instance licence's public key. Downloads
  depend on it being up; installed themes never do.
- A licence is a bearer credential: whoever holds the file can download the
  pack. The terms, the download log and the rate limit answer that; the code
  does not try to.
- The theme contract does not change. `license` stays accepted and ignored.
- The product description that premium themes ship "as themes rather than as
  plugins" is true of what the association receives and not of how it arrives.
  PRODUCT.md is updated to say both.

## Revisit triggers

- **The instance licence is decided differently** from what is listed above,
  for instance as online activation: whether the pack service can still take
  it as its credential.
- **A third party wants to sell themes:** whether the core should offer a
  licence-aware theme source on the theme screen rather than every vendor
  shipping a plugin.
- **A theme contract major:** the pack has to be republished against it, and
  whether an instance whose licence has lapsed is given the republished
  themes, so that a theme it paid for keeps rendering on the new core.
