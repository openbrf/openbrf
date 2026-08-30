# Contributing to Open BRF

Thank you for considering a contribution! This document explains how the project works and what we expect from contributions. It applies to every repository in the [openbrf](https://github.com/openbrf) organization.

> **Pre-release note:** until v1 ships, the codebase moves fast and large areas are still being scaffolded. Opening an issue before writing code matters even more than usual.

> ## External pull requests are not being accepted yet
>
> The repository is public because we develop in the open, not because the
> project is ready for contributions. Two things have to land first: v1 has to
> take shape, and the legal documents (the [CLA](CLA.md), the
> [module exception](LICENSE-EXCEPTION.md) and the trademark policy) have to be
> reviewed by a lawyer. Asking anyone to sign a contributor agreement whose
> wording we already expect to change would not be fair, so we are not asking.
>
> **Issues and discussions are very welcome in the meantime** - bug reports,
> questions, and ideas about what a Swedish housing cooperative actually needs
> are genuinely useful right now, and they cost you nothing legally. Watch the
> repository if you want to know when this changes; it will be announced here
> and in the release notes.
>
> The rest of this document describes how contribution will work once it opens,
> and how maintainers work today.

## Language policy

**English is the project language.** Everything in the repository is written in English:

- Code, identifiers, and comments
- i18n keys (translations live in `sv`/`en` resource files; `en` is the type source)
- Documentation, README files, and architecture notes
- Commit messages, PR titles, PR descriptions, and release notes
- Labels, milestones, and technical decisions recorded in issues

**Swedish is welcome in issues and discussions.** Open BRF is built for Swedish housing cooperatives, and many users are Swedish board members. If you are more comfortable writing in Swedish, do - maintainers will reply in Swedish. When a thread leads to a technical decision, a maintainer summarizes that decision in English so the project history stays readable for everyone.

**Domain terms** from Swedish cooperative law are translated to English in code and docs, following the canonical mapping in [GLOSSARY.md](GLOSSARY.md) (e.g. *medlemsförteckning* -> member register). "BRF" itself is kept as an established abbreviation. When the legal concept is the point, mention the Swedish term in a doc comment. If you need a term that is missing from the glossary, add it in the same PR.

## Before you start

1. **Features and larger changes: open an issue first.** Describe the problem and your proposed approach, and wait for a maintainer's go-ahead before writing code. This protects your time - scope, legal constraints (GDPR, BRL), and architecture fit are checked before any code exists.
2. **Bug fixes, documentation, and small improvements: go straight to a PR.** A linked issue is nice but not required.
3. **CLA:** the first time you open a PR you will be asked to sign the [Contributor License Agreement](CLA.md) via CLA Assistant. This is required before any external contribution can be merged - see [GOVERNANCE.md](GOVERNANCE.md) for why it exists.

## Development environment

- **Node.js is pinned to an exact version in `.nvmrc`** (26.8.1), and the Dev Container and CI both install precisely that: CI through `node-version-file`, the container by running `nvm install` from `.nvmrc` on create. `engines` fences the 26 line (`>=26 <27`) so a stray 25 or 27 is rejected rather than silently tolerated. Bump `.nvmrc` and `engines` together. Note that 26 is still the Current line - it reaches Active LTS on 2026-10-28, and until then it can take breaking changes.
- **pnpm** is pinned by the `packageManager` field in the root `package.json`, and you do not have to match it by hand: install any recent pnpm and it switches itself to the pinned version inside this repo. The Dev Container image already ships the right one. Outside it, `npm i -g pnpm` is enough - do **not** reach for corepack, which Node 26 no longer bundles, and nothing in the repo or CI may depend on it. Nothing may require Bun either (using it as a personal dev tool is fine).
- A **Dev Container** definition is provided - the fastest way to a working setup. It is deliberately **standalone**: a contributor touching only core never needs sibling clones of the other Open BRF repositories. On create it installs the pinned Node, runs `pnpm install`, copies `.env.example` to `.env` if you have no `.env` yet, generates the Prisma client, starts the database and applies migrations plus the job schema. If a database step fails it names which one - Docker not ready, migrations, or the job schema - and prints the command that finishes the job, rather than blaming Docker for all three; everything except the database works in the meantime. A later container restart brings the database back up on its own.
- **Docker Compose** runs PostgreSQL locally (`docker compose up -d --wait db`). The production stack - the application container and its database, the file an association actually runs - is `docker-compose.prod.yml`, described in [docs/deployment.md](docs/deployment.md). It carries its own project name and its own volume names, so a production stack and the development database never share a container or a data directory even when both are started from the same checkout.
- **Setting up without the Dev Container**: install the pinned Node (`nvm install` reads `.nvmrc`) and pnpm (`npm i -g pnpm`), then `pnpm install`, copy `.env.example` to `.env`, `docker compose up -d --wait db`, and

  ```sh
  pnpm --filter @openbrf/api db:generate   # required before lint/typecheck/test
  pnpm --filter @openbrf/api db:deploy     # apply migrations
  pnpm --filter @openbrf/api db:jobs       # install the pg-boss job schema
  ```

  `db:generate` is not optional: the generated client lives in the gitignored `apps/api/src/generated/`, and lint, typecheck and test all import it, so `pnpm verify` fails on a fresh clone until it has run.
- Monorepo layout: pnpm workspaces + Turborepo (`apps/api`, `apps/web`, `packages/*`, `e2e`).

## Coding standards

Enforced by CI on every PR; the toolchain configs in the repo are the source of truth.

- **TypeScript everywhere, strict mode.** No `any` escapes without a comment explaining why.
- **Linting: oxlint** with type-aware rules enabled. The i18n rule (`no-literal-string` from eslint-plugin-i18next) is a **hard requirement**: no hardcoded user-facing strings - every string goes through i18next keys.
- **Formatting: Prettier** with `prettier-plugin-tailwindcss` (deterministic Tailwind class order). Don't argue with the formatter; run `pnpm format`.
- **No hardcoded colors or design values.** Components reference design tokens (`var(--token)`) only - this is what makes the theme engine work. The lint catches raw hex values.
- **English identifiers** per the language policy and [GLOSSARY.md](GLOSSARY.md).
- **Comments** state what the code cannot: legal constraints (with statute references), invariants, and non-obvious trade-offs.

### Git hooks (optional)

CI is the gate - local hooks are a convenience, never a requirement. Run `pnpm hooks:install` if you want lint/format feedback before pushing.

## UI changes

UI work must follow the design system in [DESIGN.md](DESIGN.md) ("Porttavlan"). In addition to the general rules:

- **Screenshots in both themes are required** in the PR description: light and dark, before/after where relevant. `pnpm screenshots` produces them from the production stack and writes them to `screenshots/`; a screen you build is added to the list in `e2e/screenshots/screens.ts` in the same pull request. See [e2e/README.md](e2e/README.md), including the rule that seeded data has to be safe to publish - these images go into a public pull request about a statutory personal-data register.
- Tokens only - never raw color values (see above).
- Register data uses the shared monospace grid; states carry a text label plus a pattern (color is never the only signal); WCAG AA (4.5:1) holds even at 13px.
- Touch targets are at least 44px on mobile.

## Tests

- **Vitest** across the monorepo (API and web); **Playwright** for end-to-end tests, in the `e2e` workspace. `pnpm test:e2e` builds the production image, brings up `docker-compose.prod.yml` from empty volumes and drives a browser against it - never a dev server, because several of the properties under test only exist in the deployed artefact. It needs Docker running and Chromium installed once (`pnpm --filter @openbrf/e2e browsers`); see [e2e/README.md](e2e/README.md).
- `pnpm test:int` runs the suites that need a real database (`docker compose up -d db`). They run in parallel, each worker against a database of its own: the run clones a migrated template into `<database>_test_1`, `_test_2` and so on, rebuilding the template whenever the migrations change. Those databases are recreated on every run and the one in `DATABASE_URL` is never touched, so the data you develop against survives a test run.
- **Bug fixes must include a regression test** that fails without the fix.
- **Features must include tests for their core logic.** UI polish, docs, and chores are exempt.
- `pnpm test` must pass locally before you open the PR.

## Commits and pull requests

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, with optional scope, e.g. `feat(register): ...`), linted by commitlint in CI.
- **History on `main` stays linear.** Merge commits are disabled; a PR lands either by **squash** or by **rebase**, and which one you pick follows from the PR:
  - **Squash** when the commits inside the PR are working notes. The PR title becomes the commit message on `main`, so that title must follow Conventional Commits.
  - **Rebase** when the commits are already a deliberate sequence worth keeping - a migration split into reviewable steps, for instance. Every commit must then follow Conventional Commits on its own and each must build and pass CI, because each one lands on `main` separately.
- **Changesets:** user-visible changes need a changeset file (`pnpm changeset`) describing the change and its semver impact. CI reminds you if it is missing; docs/chore PRs don't need one.
- **Every review thread must be resolved before merge.** `main` enforces this, so an open comment thread blocks the merge button. Resolve a thread by fixing what it asks for, or by replying with why the code stays as it is and then resolving it - silently resolving without an answer is not review.
- Keep PRs focused - one logical change per PR. Split refactoring from behavior changes.
- Fill in the PR template; it doubles as the review checklist.

## AI-assisted contributions

AI-assisted work is **welcome** - much of Open BRF is built that way. The rules:

1. **You are the author.** You must understand every line you submit, be able to explain it in review, and have run the tests. "The AI wrote it" is never an answer to a review question.
2. **No AI attribution.** Do not add `Co-authored-by:` trailers naming AI tools, "Generated with ..." banners, or similar markers to commits, PR titles, or PR descriptions. PRs carrying them will be asked to remove them before merge.
3. **No low-effort AI spam.** Unverified bulk changes, fabricated claims about what code does, or mass-generated PRs are closed without detailed review, and repeat offenders are banned. This is standard practice across open source; we enforce it kindly but firmly.

## Security issues

Never report vulnerabilities in public issues - see [SECURITY.md](SECURITY.md).

## Conduct

All project spaces are covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Questions?

Open an issue, or start a thread in [GitHub Discussions](https://github.com/openbrf/openbrf/discussions). For how decisions are made and how to become a maintainer, see [GOVERNANCE.md](GOVERNANCE.md).
