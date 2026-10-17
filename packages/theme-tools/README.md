# @openbrf/theme-tools

The theme package format of [Open BRF](https://github.com/openbrf/openbrf):
the manifest, the archive reader and writer, the lint and inheritance. An
instance runs this package when it installs a theme, so a theme repository's
CI that runs it sees the same refusal before the theme is published.

The major version is the token contract's. Anything a theme could notice
raises it, and an additive change keeps it. 1.x is contract version 1.

## Installing

```sh
npm install --save-dev @openbrf/theme-tools
```

It depends on [`@openbrf/tokens`](https://www.npmjs.com/package/@openbrf/tokens),
the token contract a theme's values are checked against.

## Linting a packed theme

```ts
import { readFile } from "node:fs/promises";
import { lintThemePackage } from "@openbrf/theme-tools";

const result = lintThemePackage(await readFile("example-theme-1.0.0.tgz"));

if (!result.ok) {
  console.error(result.reason, result.issues);
  process.exit(1);
}
if (!result.lint.ok) {
  console.error(result.lint.findings);
  process.exit(1);
}
```

`lintThemePackage` reads the archive and lints the manifest with the function
the instance runs at install. A theme that extends another theme than the
built-in one takes the installed themes it may inherit from as its second
argument. The lint refuses a theme with a colour pair below the contrast the
contract requires for it, the statutory register's included, one that carries
anything executable and one that loads a font from a third party; warnings do
not block.

The parts are exported too: `parseThemeManifest`, `lintTheme`,
`resolveThemeChain`, `readThemeArchive` and `writeThemeArchive`.

## In a browser

The archive reader and writer, and `lintThemePackage`, `lintThemeAgainst` and
`readThemePackage` built on them, run in Node only. A bundler that resolves
the `browser` export condition, as Vite does, gets the package without them,
so a theme preview can still parse, lint and resolve a manifest.

## Documentation

- [The token contract](https://github.com/openbrf/openbrf/blob/main/docs/theme-contract.md):
  what a theme is, the tokens, inheritance, the package format, fonts and view
  variants.
- [ADR 0020](https://github.com/openbrf/openbrf/blob/main/docs/adr/0020-the-public-catalog-and-the-published-packages.md):
  the public catalog and the published packages.

## Licence

AGPL-3.0-only, with the
[Open BRF Module Exception](https://github.com/openbrf/openbrf/blob/main/LICENSE-EXCEPTION.md).
A theme written against the token contract is a module under that exception
and may be licensed on any terms. Both texts are in the package.
