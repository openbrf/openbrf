# ADR 0001: Linting and formatting toolchain

Date: 2026-08-27

## Status

Accepted

## Context

The monorepo needs a linter that enforces type-aware TypeScript rules and the
project's hard i18n requirement (no hardcoded user-facing strings, rule
`no-literal-string` from `eslint-plugin-i18next`), plus a deterministic
formatter with Tailwind class sorting.

State of the tooling in August 2026:

- **oxlint** reached stable type-aware linting in July 2026 (via
  `oxlint-tsgolint`, enabled with `--type-aware`), covering nearly all
  typescript-eslint type-aware rules at a fraction of ESLint's runtime cost.
- **oxlint JS plugins** (`jsPlugins` in `.oxlintrc.json`) have been available
  in alpha since March 2026 and can load existing ESLint v9+ plugins by npm
  package name, so ESLint-only plugins no longer force a full ESLint setup.
- **Prettier + prettier-plugin-tailwindcss** is the reference Tailwind CSS v4
  class sorter (the one shadcn/ui uses); for v4 it is configured with
  `tailwindStylesheet` pointing at the CSS entry that contains
  `@import "tailwindcss"`.
- **oxfmt** is in beta and has open bugs around Tailwind class sorting, so it
  is not yet a viable Prettier replacement for this repo.

## Decision

- **Linter: oxlint** (root `.oxlintrc.json`, `correctness` category as
  errors, type-aware mode enabled) run per package via Turborepo
  (`oxlint --config ../../.oxlintrc.json --type-aware .`).
- **i18n rule via oxlint jsPlugins**: `eslint-plugin-i18next` is loaded
  through `jsPlugins` and `i18next/no-literal-string` is set to `error`.
- **Formatter: Prettier** with `prettier-plugin-tailwindcss`
  (`tailwindStylesheet: ./apps/web/src/index.css`), run repo-wide from the
  root (`pnpm format`, `pnpm format:check`).
- **Documented fallback** (not active): if `jsPlugins` regresses, move the
  i18next rule to a minimal ESLint flat config running only
  `eslint-plugin-i18next` as a separate `lint:i18n` script wired into the
  root lint task.

### Spike outcome (measured 2026-08-27)

Verified empirically with oxlint 1.80.0, oxlint-tsgolint 7.0.2001, and
eslint-plugin-i18next 6.1.5:

- A hardcoded JSX string added to `apps/web/src/App.tsx` failed the lint as
  `error i18next(no-literal-string)` with exit code 1, both with and without
  `--type-aware`; removing it returned the lint to green.
- A floating promise in a probe file failed as
  `error typescript(no-floating-promises)` under `--type-aware`, confirming
  type-aware rules are active in the same run.

The jsPlugins path works; the ESLint sidecar fallback is NOT needed.

## Consequences

- One linter binary, one config; no ESLint installation in the repo today.
- The i18n hard requirement is enforced by the same `pnpm lint` everyone runs.
- jsPlugins is still alpha: a regression could temporarily break the i18next
  rule, in which case the documented ESLint sidecar fallback is activated.

## Revisit triggers

- **oxfmt 1.0**: reevaluate swapping Prettier for oxfmt once its Tailwind
  sorting bugs are closed.
- **jsPlugins stable**: drop the documented ESLint fallback plan entirely.
- **oxlint ships a native no-literal-string equivalent**: drop the JS plugin.
