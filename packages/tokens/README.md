# @openbrf/tokens

The design token contract of [Open BRF](https://github.com/openbrf/openbrf):
every token a theme can set, the default theme, Porttavlan, and the functions
that resolve a token set and build the stylesheet from it.

The contract is versioned with semver, independently of the application.

## Installing

```sh
npm install @openbrf/tokens
```

A theme is data, not code, so a theme author usually reaches this package
through [`@openbrf/theme-tools`](https://www.npmjs.com/package/@openbrf/theme-tools),
which depends on it. A plugin's view styles itself with the CSS custom
properties the contract names, which the instance already serves.

## What it exports

- `TOKENS`, `TOKEN_NAMES` and `REQUIRED_TOKEN_NAMES`: the contract, one
  definition per token, and `cssVariableName` for the custom property each one
  becomes.
- `PORTTAVLAN_LIGHT` and `PORTTAVLAN_DARK`: the default theme's two token sets.
- `resolveTokens(theme, inheritFrom)`: merges a partial token set over the one
  it inherits from and reports what was derived and what is still missing.
- `buildThemeStylesheet({ light, dark })`: the stylesheet an instance serves,
  with light on `:root`, dark for a system that asks for it, and an explicit
  choice winning in both directions.
- `checkContrast`, `contrastRatio` and `CONTRAST_PAIRS`: the WCAG contrast
  checks the theme lint applies.

```ts
import {
  buildThemeStylesheet,
  PORTTAVLAN_DARK,
  PORTTAVLAN_LIGHT,
} from "@openbrf/tokens";

const css = buildThemeStylesheet({
  light: PORTTAVLAN_LIGHT,
  dark: PORTTAVLAN_DARK,
});
```

## Documentation

- [The token contract](https://github.com/openbrf/openbrf/blob/main/docs/theme-contract.md):
  every token, the accessibility rules and what is themeable.

## Licence

AGPL-3.0-only, with the
[Open BRF Module Exception](https://github.com/openbrf/openbrf/blob/main/LICENSE-EXCEPTION.md).
A theme or plugin view written against the token contract is a module under
that exception and may be licensed on any terms. Both texts are in the
package.
