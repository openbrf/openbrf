# @openbrf/tokens

The token contract of [Open BRF](https://github.com/openbrf/openbrf), the
platform for Swedish housing cooperatives: every design token with the role it
plays and the token it falls back to, the values of the default theme,
Porttavlan, in light and dark, the contrast pairs every theme is checked
against, and the functions that resolve a token set and write it out as a
stylesheet. Themes are written against it, and plugin views style themselves
with it.

## Installing

```sh
pnpm add -D @openbrf/tokens
```

A theme built with
[`@openbrf/theme-tools`](https://www.npmjs.com/package/@openbrf/theme-tools) has
it already, as a dependency of that package.

## The contract

This package is the
[token contract](https://github.com/openbrf/openbrf/blob/main/docs/theme-contract.md)
in code. A token's name describes the role it plays, never a colour, and a
theme may change what a token looks like but never what it means.

## Versions

The major version is the token contract's, `TOKEN_CONTRACT_VERSION`. Adding a
token is a minor version, and always ships a fallback derived from an existing
token, so a theme written against an earlier minor keeps working. Renaming or
removing a token is a major version.

## Starting a theme

[openbrf/example-theme](https://github.com/openbrf/example-theme) is the example
theme, written against this contract the way any theme is. Start from it.

## Licence

AGPL-3.0-only, with the
[Open BRF Module Exception](https://github.com/openbrf/openbrf/blob/main/LICENSE-EXCEPTION.md).
Both texts are in this package, as `LICENSE` and `LICENSE-EXCEPTION.md`. A
theme or plugin that interacts with Open BRF only through the documented
extension interfaces, the token contract among them, is a module under that
exception: it is not a work based on Open BRF, and it may be licensed on terms
of its author's choosing, proprietary ones included.
