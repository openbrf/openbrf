# ADR 0020: The public catalog and the published packages

Date: 2026-09-27

## Status

Accepted

## Context

An instance installs plugins and themes only from tarballs named in a catalog
index, verified against a sha512 the index states, and never from a package
registry ([ADR 0003](0003-plugin-loading-and-module-resolution.md)). The index
format was documented for plugins only. The theme screen read an index of its
own, in a shape the plugin parser refused and that refused the plugin entry in
turn, so no one index could list both kinds and the theme screen had no curated
default at all.

The plugin SDK was configured for a registry that requires an access token for
every install, public packages included, and the theme tools and the tokens
they depend on were private. A plugin or theme author outside the organization
could therefore not build against the contract, nor run in their own CI the
check the instance runs at install. The catalog repository and the repositories
meant to hold a reference plugin and an example theme were private, so an
instance could read the curated catalog only with a token.

The project requires provenance of a catalog listing, and SECURITY.md states
that catalog listings carry provenance requirements.

## Decision

### One index for both kinds

The curated catalog is one index listing plugins and themes alike, in the
format the plugin contract documents. Its schema is part of the plugin contract
and is exported by `@openbrf/plugin-sdk` as `catalogSchema` and
`parseCatalogIndex`, so the instance and the catalog's own check read it with
one definition. An id appears once in the index whatever the entry's type, and
an index breaking that, or carrying any entry the instance cannot read, is
refused whole. A plugin entry names its npm package; a theme entry does not.

The theme screen reads the index through the plugin system's catalog client,
download and digest check. It is held to the same curation rule, the same
https-only rule for a curated instance and the same cache, and with no index
configured it reads the curated one.

### Where the index and the tarballs live

The index is served from the `main` branch of the public `openbrf/catalog`
repository, at the raw address built into the instance. Serving it from a
branch is the mutability an index needs - delisting is a commit - while what an
instance installs is pinned per entry by the tarball's digest.

Each listed tarball is an asset of an immutable GitHub release of the
repository its source lives in. A release's assets cannot change after it is
published, which matters beyond the first install: the reconcile downloads again
from the recorded URL whenever its archive store lacks the file.

### What a listing must meet, and where it is checked

A listing is merged when its artifact is on such a release under a tag equal to
`v` and its version, carries a build attestation from that repository's release
workflow, has the size and digest the entry states, agrees with the entry about
everything the entry declares, declares no runtime dependencies, and passes the
package check or the install lint for its kind. The catalog repository runs
these checks on every pull request and every night, over the network. The
checks an author runs on their own package are exported by the published
packages: `pluginPackageProblems` from the SDK and `lintThemePackage` from the
theme tools.

Attestations are verified when a listing is checked, not by the instance at
install.

### The published packages

`@openbrf/plugin-sdk`, `@openbrf/theme-tools` and `@openbrf/tokens` are
published publicly on npmjs.com under the `@openbrf` scope, with provenance.
They stay AGPL-3.0-only, and each tarball carries the licence and the module
exception, under which a plugin or theme built against them is a module that
may be licensed on any terms. The SDK's major version is the plugin API
version, and the theme tools' major version is the token contract's, so an
additive change keeps the major and anything a plugin or theme could notice
raises it.

The reference plugin and the example theme are built against the published
packages the way any author's would be, released and listed like any other
package, and licensed MIT-0 without a contributor agreement, so that an author
may start a proprietary module from either without keeping a notice.

## Consequences

- The gate stays offline. The instance's tests install from fixtures built in
  this repository, listed in an index in the same format; only the catalog
  repository's check reads what is actually published.
- A listed artifact URL has to answer for as long as any instance holds that
  version, which is what the immutable release provides.
- An index in the theme screen's earlier shape is no longer read.
- An operator who wrote the curated address into the environment in another
  spelling is refused: a configured address is curated only if it is the one
  built in, character for character.
- The optional catalog token is sent to the index and to every artifact URL the
  index names, whatever their origin; only a redirect to another origin drops
  it. It is for an index that requires one, and the curated catalog does not.
- Whoever can merge to the catalog's `main` decides what every instance is
  offered. The index is not signed; each entry's digest is what binds an
  install to it.

## Revisit triggers

- **A third party asks to be listed**: whether listed tarballs are mirrored into
  the catalog's own releases, which would make the curator a redistributor, and
  on what terms a listing is accepted.
- **Instances run outside Apteo's hosting**: moving the index to an address on
  a domain of the project's own, with a release that accepts both addresses
  while instances move, so that the address every instance trusts no longer
  depends on the repository host.
- **Before a listing from outside the organization is merged**: verifying
  attestations in the instance at install, rather than only when a listing is
  checked.
- **A second plugin API version**: the SDK's second major, and how long a host
  carries both.
