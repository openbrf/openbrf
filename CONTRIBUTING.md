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

One exception: the root README carries a short summary in Swedish, so the project can be found by the Swedish board members and residents it is built for. It says what the English README says, and a change to one changes the other in the same pull request.

**Swedish is welcome in issues and discussions.** Open BRF is built for Swedish housing cooperatives, and many users are Swedish board members. If you are more comfortable writing in Swedish, do - maintainers will reply in Swedish. When a thread leads to a technical decision, a maintainer summarizes that decision in English so the project history stays readable for everyone.

**Domain terms** from Swedish cooperative law are translated to English in code and docs, following the canonical mapping in [GLOSSARY.md](GLOSSARY.md) (e.g. *medlemsförteckning* -> member register). "BRF" itself is kept as an established abbreviation. When the legal concept is the point, mention the Swedish term in a doc comment. If you need a term that is missing from the glossary, add it in the same PR.

## Before you start

1. **Features and larger changes: open an issue first.** Describe the problem and your proposed approach, and wait for a maintainer's go-ahead before writing code. This protects your time - scope, legal constraints (GDPR, BRL), and architecture fit are checked before any code exists.
2. **Bug fixes, documentation, and small improvements: go straight to a PR.** A linked issue is nice but not required.
3. **CLA:** the first time you open a PR you will be asked to sign the [Contributor License Agreement](CLA.md) via CLA Assistant. This is required before any external contribution can be merged - see [GOVERNANCE.md](GOVERNANCE.md) for why it exists.

## Development environment

- **Node.js is pinned to an exact version in `.nvmrc`** (26.12.0), and the Dev Container and CI both install precisely that: CI through `node-version-file`, the container by running `nvm install` from `.nvmrc` on create. `engines` fences the 26 line (`>=26 <27`) so a stray 25 or 27 is rejected rather than silently tolerated. Bump `.nvmrc` and `engines` together. Note that 26 is still the Current line - it reaches Active LTS on 2026-10-28, and until then it can take breaking changes.
- **pnpm** is pinned by the `packageManager` field in the root `package.json`, and you do not have to match it by hand: install any recent pnpm and it switches itself to the pinned version inside this repo. The Dev Container image already ships the right one. Outside it, `npm i -g pnpm` is enough - do **not** reach for corepack, which Node 26 no longer bundles, and nothing in the repo or CI may depend on it. Nothing may require Bun either (using it as a personal dev tool is fine).
- A **Dev Container** definition is provided - the fastest way to a working setup. It is deliberately **standalone**: a contributor touching only core never needs sibling clones of the other Open BRF repositories. On create it installs the pinned Node, runs `pnpm install`, copies `.env.example` to `.env` if you have no `.env` yet, generates the Prisma client, starts the database and applies migrations plus the job schema. If a database step fails it names which one - Docker not ready, migrations, or the job schema - and prints the command that finishes the job, rather than blaming Docker for all three; everything except the database works in the meantime. A later container restart brings the database back up on its own.
- **Docker Compose** runs PostgreSQL locally (`docker compose up -d --wait db`). The development ports are the defaults - the database on 5432, the API on 3000, the web development server on 5173 - and where something else on your machine holds one, `.env` moves it: `OPENBRF_DB_PORT`, `PORT` and `OPENBRF_WEB_PORT`, with `DATABASE_URL` and `APP_URL` following them (`.env.example` says which goes with which). The production stack - the application container and its database, the file an association actually runs - is `docker-compose.prod.yml`, described in [docs/deployment.md](docs/deployment.md). It carries its own project name and its own volume names, so a production stack and the development database never share a container or a data directory even when both are started from the same checkout.
- **Setting up without the Dev Container**: install the pinned Node (`nvm install` reads `.nvmrc`) and pnpm (`npm i -g pnpm`), then `pnpm install`, copy `.env.example` to `.env`, `docker compose up -d --wait db`, and

  ```sh
  pnpm --filter @openbrf/api db:generate   # required before lint/typecheck/test
  pnpm --filter @openbrf/api db:deploy     # apply migrations
  pnpm --filter @openbrf/api db:jobs       # install the pg-boss job schema
  ```

  `db:generate` is not optional: the generated client lives in the gitignored `apps/api/src/generated/`, and lint, typecheck and test all import it, so `pnpm verify` fails on a fresh clone until it has run.
- Monorepo layout: pnpm workspaces + Turborepo (`apps/api`, `apps/web`, `packages/*`, `e2e`).
- **Vite, Vitest and oxlint come from one package, `vite-plus`**, pinned to an exact version in the pnpm catalog in `pnpm-workspace.yaml` ([ADR 0025](docs/adr/0025-vite-plus-for-build-test-and-lint.md)). The scripts call its CLI, `vp`: `pnpm --filter @openbrf/web dev` runs `vp dev`, and `test` runs `vp test run` in every package. Tests import from `vite-plus/test`, not `vitest`, and the lint holds them to it. Bump the three together by changing the catalog entry. Do not adopt `vp hooks`, `vp staged`, `vp env` or `vp fmt`, and review the whole diff if you run `vp migrate`: without prompts it also moves Prettier to Oxfmt and renames `.nvmrc`.

## Coding standards

Enforced by CI on every PR; the toolchain configs in the repo are the source of truth.

- **TypeScript everywhere, strict mode.** No `any` escapes without a comment explaining why.
- **Linting: oxlint** with type-aware rules enabled, run by `pnpm lint` (each package runs `vp lint .`, the oxlint that ships with [Vite+](docs/adr/0025-vite-plus-for-build-test-and-lint.md)). The rules are in the `lint` block of the root `vite.config.ts`, which configures nothing else; apps/web's own `vite.config.ts` is the one that builds the client. The i18n rule (`no-literal-string` from eslint-plugin-i18next) is a **hard requirement**: no hardcoded user-facing strings - every string goes through i18next keys.
- **Formatting: Prettier** with `prettier-plugin-tailwindcss` (deterministic Tailwind class order). Don't argue with the formatter; run `pnpm format`.
- **No hardcoded colors or design values.** Components reference design tokens (`var(--token)`) only - this is what makes the theme engine work. The lint catches raw hex values.
- **English identifiers** per the language policy and [GLOSSARY.md](GLOSSARY.md).
- **Import boundaries.** An application does not import the other, a package does not import an application, a published package does not import a private one, and another workspace is imported by its package name rather than a relative path. `ciphersweet-js` and `sodium-native` are imported only in `apps/api/src/crypto` ([ADR 0002](docs/adr/0002-field-encryption-and-blind-indexes.md), [ADR 0015](docs/adr/0015-stored-files-encrypted-at-rest.md)). The `no-restricted-imports` rule in the root `vite.config.ts` refuses the rest, and its message says where the code goes instead. [AGENTS.md](AGENTS.md) has the table of where each kind of code belongs.
- **The code map** in `docs/code-map/` lists every API module and every exported name, by file, and is generated by `pnpm code-map`. `pnpm lint:guards` fails when it is stale, so regenerate it in the change that adds, renames or removes an export; on a merge conflict in the map, take either side and regenerate.
- **Comments** state what the code cannot: legal constraints (with statute references), invariants, and non-obvious trade-offs.
- **The statutory archive's guards stay on.** The member register, the audit log, the termination register and the obligation ledger are append-only by law (EFL 5 kap., via BRL 9 kap.) and by database trigger, and the application connects as a role that cannot switch one off. Three integration suites do disable a guard: two because a suite that writes to an append-only table has no other way to remove its own rows, and the deploy's trigger check to see it stop on a guard that is off. They are named in `scripts/check-statutory-guards.mjs`, which CI runs and which refuses a fourth. If you need one, add it there with the reason - a bypass that reads as ordinary test cleanup is exactly what the check exists to make deliberate.

### Git hooks (optional)

CI is the gate - local hooks are a convenience, never a requirement. Run `pnpm hooks:install` if you want lint/format feedback before pushing.

## UI changes

UI work must follow the design system in [DESIGN.md](DESIGN.md) ("Porttavlan"). In addition to the general rules:

- **Screenshots in both themes are required** in the PR description: light and dark, before/after where relevant. `pnpm screenshots` produces them from the production stack and writes them to `screenshots/`; a screen you build is added to the list in `e2e/screenshots/screens.ts` in the same pull request. See [e2e/README.md](e2e/README.md), including the rule that seeded data has to be safe to publish - these images go into a public pull request about a statutory personal-data register.
- Tokens only - never raw color values (see above).
- Register data uses the shared monospace grid; states carry a text label plus a pattern (color is never the only signal); WCAG AA (4.5:1) holds even at 13px.
- Touch targets are at least 44px on mobile.

## Tests

- **Vitest** across the monorepo (API and web), run through `vp test`; **Playwright** for end-to-end tests, in the `e2e` workspace. `pnpm test:e2e` builds the production image, brings up `docker-compose.prod.yml` from empty volumes and drives a browser against it - never a dev server, because several of the properties under test only exist in the deployed artefact. It needs Docker running and Chromium installed once (`pnpm --filter @openbrf/e2e browsers`); see [e2e/README.md](e2e/README.md).
- `pnpm test:int` runs the suites that need a real database (`docker compose up -d db`). They run in parallel, each worker against a database of its own: the run clones a migrated template into `<database>_test_1`, `_test_2` and so on, rebuilding the template whenever the migrations change. Those databases are recreated on every run and the one in `DATABASE_URL` is never touched, so the data you develop against survives a test run.
- `pnpm lint:guards` also runs `scripts/dockerfile-guards.test.mjs`, which takes the two build-time checks out of the `Dockerfile` (the prune check and the permission check) and runs them as written, as root in the Dockerfile's base image, against trees that must pass and trees that must not. It needs Docker, pulls the base image on first use, and starts one short-lived `--rm` container per case. Without Docker it is skipped locally and fails under `CI`. Run it alone with `node --test scripts/dockerfile-guards.test.mjs`; `DOCKERFILE_GUARDS_DOCKERFILE=<path>` points it at another copy of the Dockerfile.
- **CI pulls PostgreSQL and the Dockerfile's base image from copies in `ghcr.io/openbrf/ci-mirror`**, not from Docker Hub or ECR Public, whose anonymous quotas CI runners share with everyone else's CI; the release build does too, and the Semgrep scan falls back to its copy there when Google's mirror lacks a new digest. The pins stay in `docker-compose.prod.yml`, the `Dockerfile` and `docker/semgrep/Dockerfile`, and `.github/workflows/ci-images.yml` copies a pin, under the same digest, whenever a push to a branch of this repository changes it. A pull request from a fork that changes a pin needs nothing either: `.github/workflows/ci-images-pr.yml` reads its pins as text, with the base branch's code, and copies them. Each CI job waits up to ten minutes for a copy before it fails. `scripts/prune-ci-mirror.mjs` deletes the `pr-<number>` copies of closed pull requests from the mirror, on `main`'s pushes and the daily run, except any that a pin or an open pull request still names. `scripts/ci-images.mjs` explains the rest.
- **Bug fixes must include a regression test** that fails without the fix.
- **Features must include tests for their core logic.** UI polish, docs, and chores are exempt.
- `pnpm test` must pass locally before you open the PR.

## Commits and pull requests

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, with optional scope, e.g. `feat(register): ...`), linted by commitlint in CI: the PR title and every commit in the PR.
- **A `docs` pull request gets no CodeRabbit review.** `.coderabbit.yaml` skips any pull request whose title contains `docs:` or `docs(`, so documentation-only changes do not take a review slot from code. A maintainer still reviews them. A pull request that changes code, configuration, tests or generated files must therefore not use the `docs` type, even when most of it is prose: use the type that fits the code, such as `feat`, `fix` or `chore`. Unrelated docs-only changes may be batched into one pull request per topic instead of one each.
- **History on `main` stays linear.** Merge commits are disabled; a PR lands either by **squash** or by **rebase**, and which one you pick follows from the PR:
  - **Squash** when the commits inside the PR are working notes. The PR title becomes the commit message on `main`, so that title must follow Conventional Commits. CI cannot know which way a PR will land, so working notes need a conventional header too (`fix: address review`).
  - **Rebase** when the commits are already a deliberate sequence worth keeping - a migration split into reviewable steps, for instance. Every commit must then follow Conventional Commits on its own and each must build and pass CI, because each one lands on `main` separately.
- **Changesets:** user-visible changes need a changeset file (`pnpm changeset`) describing the change and its semver impact; docs/chore PRs don't need one. Nothing in CI checks for it - the PR template's checklist asks, and review decides.
- **Releases of the public packages:** `@openbrf/plugin-sdk`, `@openbrf/theme-tools` and `@openbrf/tokens` are published to npmjs.com with provenance. A maintainer bumps their versions with `pnpm changeset version` in a pull request of its own, and once that is merged runs the **Release** workflow on `main`. Nobody publishes from a laptop.
- **Every review thread must be resolved before merge.** `main` enforces this, so an open comment thread blocks the merge button. Resolve a thread by fixing what it asks for, or by replying with why the code stays as it is and then resolving it - silently resolving without an answer is not review.
- **A new ADR takes the next number after the highest on `main`.** Fetch `origin/main` and look at `docs/adr/` there, not at your branch: other open pull requests have taken numbers your branch cannot see. `pnpm lint:guards` fails when two records share a number, naming both files. It sees the pull request merged into `main`, so if another pull request lands your number first, the check fails on your next run and you renumber the record and the links to it.
- Keep PRs focused - one logical change per PR. Split refactoring from behavior changes.
- Fill in the PR template; it doubles as the review checklist.

## Releasing the platform

The platform is four packages released as one: `@openbrf/api`, `@openbrf/web`, `@openbrf/i18n` and `@openbrf/shared` are a fixed group in `.changeset/config.json`, so a release gives all four the same version. That version is the platform's - the image is tagged with it and an instance names it when it starts. `@openbrf/plugin-sdk`, `@openbrf/theme-tools` and `@openbrf/tokens` are published on their own and keep versions of their own.

**What bump a changeset asks for.** A patch fixes something without changing anything an operator does, and is installed without anybody choosing it. Before v1, a minor may carry anything an operator has to act on; from v1 on, that is a major. Acting on it means any of:

- a new required variable, or a variable removed or renamed;
- a PostgreSQL major version no longer supported;
- a plugin API version dropped from `SUPPORTED_PLUGIN_API_VERSIONS` (`packages/plugin-sdk/src/api-version.ts`);
- a document version of the management API removed;
- a data change that needs a manual step.

No changeset says `major` before v1: on a 0.x version it would move the whole group to 1.0.0.

**A release** is the maintainer's, in three steps:

1. The release pull request, which is `pnpm changeset version` and `pnpm format` and nothing else, committed and signed by the maintainer. It turns the pending changesets into each package's `CHANGELOG.md` and gives the group its new version.
2. Once it has merged, a signed tag on its merge commit: `git tag -s vX.Y.Z -m "Open BRF X.Y.Z" <merge commit>`, pushed.
3. The tag starts `.github/workflows/image.yml`, whose first job waits in the `ghcr` environment for the maintainer's approval. The run then checks that the tag is annotated and carries a signature GitHub verifies, by an address listed in `.github/release-signers` on `main`; that it is a plain version all four packages carry; that its commit is on `main` and that CI passed there; and that the four changelogs have notes for it (`scripts/release-notes.mjs`). Only then does it build the image for amd64 and arm64, push each by digest and start that digest beside PostgreSQL; publish the image under its exact version with its build provenance attestation, and the GitHub release; and, last, move the release line tags (`scripts/release-lines.sh`).

**The release body.** GitHub refuses a release body over 125,000 characters, so the body holds at most 120,000. When the notes fit, the body is the notes. When they do not, it holds the first whole entries that fit, in the notes' order (major, then minor, then patch changes, no entry cut), and ends with a line that says how many entries are left out and links the `CHANGELOG.md` of each of the four packages at the tag. The full notes are always attached to the release as `release-notes-X.Y.Z.md`. `node scripts/release-notes.mjs X.Y.Z --body` prints the body, and without `--body` the full notes.

Only a repository admin can create a release tag (`.github/rulesets/restrict-release-tag-creation.json`), and nobody can move or delete one (`.github/rulesets/protect-release-tags.json`), so a release that fails after its tag is pushed is fixed forward with the next patch release. Both rulesets are imported under the repository's Settings, Rules; the files are their record. [docs/deployment.md](docs/deployment.md), "Versions and upgrades", is the same contract from the operator's side.

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
