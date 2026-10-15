# ADR 0025: Vite+ for build, test and lint

Date: 2026-10-14

## Status

Accepted. Amends [ADR 0001](0001-linting-and-formatting.md).

## Context

The web client is built and served by Vite, every workspace is tested with
Vitest, and every workspace is linted with oxlint and oxlint-tsgolint (ADR
0001). Each of them was a dependency of its own in each package that used it,
and each moved on its own Dependabot bump.

Vite+ (`vite-plus`, MIT) is one CLI, `vp`, that ships Vite, Vitest, Oxlint and
tsgolint together at versions its release tests as a set. Vite+ 1.2.0 ships
Vite 8.3.4, Vitest 5.0.4, Oxlint 1.88.0 and tsgolint 7.0.2004: the versions
this repository already ran, one patch or minor newer. Moving to it changes
which package the tools come from and how they are configured. It does not
change the bundler, the test runner or the lint engine.

Vite+ also offers a task runner (`vp run`), a formatter (Oxfmt, through `vp
fmt`), a combined `vp check`, a library bundler (`vp pack`), git hooks (`vp
hooks`, `vp staged`), Node version management (`vp env`) and a CI action
(`setup-vp`). Each of those would replace something here that works.

## Decision

- **One pinned `vite-plus`.** The pnpm catalog in `pnpm-workspace.yaml` pins
  `vite-plus` to an exact version, and every package that builds, tests or
  lints depends on it as `catalog:`. `vite` is an alias of Vite+'s own build,
  `@voidzero-dev/vite-plus-core`, through the catalog and a `vite@*` override,
  so the Vite that `@module-federation/vite`, `@tailwindcss/vite` and
  `@vitejs/plugin-react` import is the one `vp build` runs. The plugins'
  `vite` peer ranges name Vite's version numbers and cannot match Vite+'s, so
  `peerDependencyRules.allowAny` accepts it.
- **Same script names, `vp` behind them.** `lint` is `vp lint .` and `test` is
  `vp test run` in every package; apps/web's `dev`, `build` and `preview` are
  `vp dev`, `vp build` and `vp preview`. Turborepo and CI call the scripts, so
  neither changed.
- **The lint configuration is the `lint` block of the root `vite.config.ts`**,
  which replaces `.oxlintrc.json` with the same plugins, `jsPlugins`
  (`eslint-plugin-i18next`), type-aware mode, categories, rules and ignore
  patterns. `vp lint` reads that block from the root config wherever it runs,
  so a package's own `vite.config.ts` (apps/web's) carries no `lint` block and
  does not need one. The root config holds nothing else: no build, test or
  format settings.
- **One rule added**, `vite-plus/prefer-vite-plus-imports`: tests import from
  `vite-plus/test` and configs from `vite-plus`, not from `vitest` or `vite`
  directly, so a file cannot reach a Vite or Vitest that the pinned `vite-plus`
  does not ship.
- **Kept as they are:**
  - **Turborepo.** `vp run` caches locally only and documents no
    affected-package filter or `--continue`, and Vite+ says nothing about
    running inside Turborepo. The task graph in `turbo.json` stays.
  - **Prettier.** ADR 0001's trigger for Oxfmt is its 1.0, and Oxfmt is still
    0.x. `vp fmt` and the `fmt` block are not used.
  - **`tsc --noEmit`** for type-checking, and **`tsc`** for the packages'
    `dist`. `vp check`'s type-check and `vp pack` would change how tsconfig
    files are chosen and what is published.
  - **`.githooks`**, which contributors opt into with `pnpm hooks:install`.
    `vp hooks` and `vp staged` would take over `core.hooksPath`.
  - **`.nvmrc`** and the pinned `setup-node` and pnpm steps in CI, not `vp env`
    or `setup-vp`.
  - **`fixtures/example-plugin`** on plain Vite. It stands for a plugin a third
    party builds with its own lockfile, and is not a workspace member.
- **The production image holds none of it.** The Dockerfile's prune check
  fails the build if `vite-plus@*` or any `@voidzero-dev+*` package is left in
  the virtual store, next to the checks for Vite, Vitest, Turborepo and
  TypeScript.

### Checked when it was adopted (2026-10-14)

- `vite-plus` 1.2.0 installs and runs with pnpm 12.13.0, which the Vite+ docs
  neither list nor exclude: `vp --version` reports the bundled tools, and
  `pnpm install` passes the workspace's supply-chain policies.
- No rule was lost. In every package, oxlint 1.87.0 with the old
  `.oxlintrc.json` and `vp lint` with the root config read the same files; the
  first ran 144 rules, the second 145, the one added above.
- The rules still fire. A probe in apps/web with a hardcoded JSX
  string, a floating promise and an import from `vitest` failed as
  `i18next(no-literal-string)`, `typescript(no-floating-promises)` and
  `vite-plus(prefer-vite-plus-imports)`, read from the root config.
- `vp migrate` was run at the workspace root, as the Vite+ docs require for a
  monorepo. Run without prompts, it also moves Prettier to Oxfmt and reformats
  the tree, renames `.nvmrc` to `.node-version` in the workflows, and adds a
  `.gitignore` to each package. None of that was kept. Whoever runs it again
  reviews its diff against this decision.

## Consequences

- Vite, Vitest and Oxlint move only when `vite-plus` releases, and together:
  one Dependabot bump of the catalog entry instead of several.
- A contributor who expects `vite.config.ts` at the root to configure the web
  client finds a lint configuration instead. apps/web's own `vite.config.ts`
  is the one that builds it, and the root file says so.
- The Turborepo `lint` task lists the root `vite.config.ts` as an input in
  place of `.oxlintrc.json`, so a rule change still invalidates every
  package's lint cache.
- `@module-federation/vite` runs on Vite+'s build of Vite. The federation build
  was verified once, with a temporary Playwright harness run outside CI that
  loaded a built plugin's `remoteEntry` in a browser. No committed end-to-end
  test loads a plugin `remoteEntry`: the `PluginView` unit test mocks the
  loader, and the API integration test only checks that the fixture's
  `remoteEntry.js` is discovered. A federation regression after a `vite-plus`
  bump is therefore not caught by CI; check a plugin view by hand, or add a
  production-build browser test, before relying on it.

## Revisit triggers

- **Oxfmt 1.0**: ADR 0001's trigger. Try `vp fmt` with `printWidth: 80` and
  `sortTailwindcss.stylesheet`, and switch only if the Tailwind class order
  matches Prettier's.
- **`vp run` with a remote cache and affected-package filtering**: weigh it
  against Turborepo.
- **`vp check` documenting how it picks tsconfig files**: try its type-check in
  place of `tsc --noEmit`, starting with one package.
