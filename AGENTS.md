# Working in Open BRF

## Before writing a function, a helper or a type

Search the code map for it. `docs/code-map/` lists each API module with what it
owns and every name the repository exports, by file: `api.md`, `web.md`,
`packages.md` and `e2e.md`. Search for the term `GLOSSARY.md` gives as well as
for the name you would choose. Where a code graph is available,
`search_graph` finds a definition and `trace_path` its callers.

`pnpm install` writes the map, and `pnpm code-map` writes it again; it is not
committed. Run `pnpm code-map` after merging the base branch or after adding,
renaming or removing an export, so the map you search shows them. A module's
entry in the map is the first paragraph of the doc comment above its
`@Module`, so open that comment with what the module owns.

## Where code belongs

| Kind of code                | Home                                 |
| --------------------------- | ------------------------------------ |
| Used by one application     | that application, next to its caller |
| Used by both applications   | `packages/shared`                    |
| Part of the plugin contract | `packages/plugin-sdk`                |
| Part of the theme contract  | `packages/theme-tools`               |
| Design values               | `packages/tokens`                    |
| Translations                | `packages/i18n`                      |

A helper copied into a second file belongs one level up.

`pnpm lint` holds the boundaries between these homes with the
`no-restricted-imports` rule in `vite.config.ts`, and a refused import's message
names where the code goes instead. The public website's boundary is held by
`apps/api/src/site/site-boundary.spec.ts`.

## Names and decisions

- `GLOSSARY.md` gives the one English term for each domain concept, binding for
  identifiers, i18n keys and prose.
- `docs/adr/` records the decisions; read the ones a change touches first.
- `docs/*-contract.md` and `docs/actions.md` are the surfaces other code builds
  on, `DESIGN.md` governs the interface, and `CONTRIBUTING.md` covers running,
  testing and submitting.

## Commits

The required `Validate PR title` check runs commitlint on the pull request's
title and on every commit in it, because a pull request may land by rebase
(see "Commits and pull requests" in `CONTRIBUTING.md`). One commit with a
message that is not a Conventional Commit turns the pull request red.

- Give every commit a conventional header, working notes too:
  `fix: address review`, not `address review`.
- Bring `main` in with git's own merge message, which commitlint skips:
  `git merge origin/main` writes "Merge remote-tracking branch 'origin/main'
  into ...". Otherwise name the merge `chore: merge main`. A message such as
  "Merge main" fails.
- Before pushing, run `pnpm exec commitlint --from origin/main --to HEAD`.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
