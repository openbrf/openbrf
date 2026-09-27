# @openbrf/theme-tools

The theme package format of [Open BRF](https://github.com/openbrf/openbrf), the
platform for Swedish housing cooperatives: `parseThemeManifest`, the archive
reader and writer, `resolveThemeChain` for inheritance, and `lintTheme`, the
same code an instance runs when a theme is installed. `lintThemePackage` is
that check in one call: it reads a packed theme and lints it against the themes
it may extend, and answers either the reader's refusal or the manifest with
every lint finding. A theme repository's CI can therefore see the refusal an
instance would give before the theme is released.

## Installing

```sh
pnpm add -D @openbrf/theme-tools
```

It depends on [`@openbrf/tokens`](https://www.npmjs.com/package/@openbrf/tokens),
the token contract a theme is written against.

## The contract

This package implements the
[token contract](https://github.com/openbrf/openbrf/blob/main/docs/theme-contract.md):
what a theme is, what it may change and what it may not, the accessibility
gate, and how a theme is packed and installed.

## Versions

The major version follows the token contract's. Adding a token is a minor
version of the contract and a minor release of this package; renaming or
removing one is a major version of both.

## Starting a theme

[openbrf/example-theme](https://github.com/openbrf/example-theme) is the example
theme, packed and linted with this package the way any theme is. Start from it.

## Licence

AGPL-3.0-only, with the
[Open BRF Module Exception](https://github.com/openbrf/openbrf/blob/main/LICENSE-EXCEPTION.md).
Both texts are in this package, as `LICENSE` and `LICENSE-EXCEPTION.md`. A
theme that interacts with Open BRF only through the documented extension
interfaces, the token contract among them, is a module under that exception: it
is not a work based on Open BRF, and it may be licensed on terms of its
author's choosing, proprietary ones included.
