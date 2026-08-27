# ADR 0003: Plugin loading and module resolution

Date: 2026-08-27

## Status

Accepted

## Context

The plugin system is a v1 core feature and the largest technical risk in the
project: the board installs a plugin from a curated catalog through the admin
UI, and the plugin contributes both backend behaviour (a NestJS
`DynamicModule`) and frontend views, without the application being rebuilt.

Plugins are installed into `/data/plugins`, a directory on a Docker volume
that is entirely separate from the application's own `node_modules`. The
original design assumption was that declaring `@nestjs/*` as
`peerDependencies` in the plugin package would be enough to make the plugin
reuse the host's NestJS instance, because a second copy of `@nestjs/common`
breaks dependency injection (decorator metadata and `instanceof` checks stop
matching across two copies; the classic symptom is
`metatype is not a constructor`, but the failure can also surface much later
at `ModuleRef` or `Reflector` usage).

That assumption needed testing before the loader was written, because it
determines the installer, the directory layout, and the boot sequence.

## Decision

- **Plugins ship a prebuilt CJS bundle** whose only externals are the host
  packages. `import()` of that bundle returns a factory producing a NestJS
  `DynamicModule`, which receives a host-injected, permissions-scoped SDK
  object. Plugins never import `@nestjs/*` for values at runtime beyond what
  the host resolves for them.
- **Bridge host module resolution with `NODE_PATH`** set to the API's
  `node_modules` directory at process start. CJS `require` honours it, which
  is what the plugin bundles use.
- **Install with `npm install --omit=peer`.** npm 7 and later installs
  `peerDependencies` automatically, which would place a second copy of
  `@nestjs/common` beside the plugin and silently defeat the bridge.
- **The loader maintains `/data/plugins/package.json` as the source of truth**
  for installed plugins and installs from it, rather than invoking
  `npm install <package>` against a bare directory.
- **The loader asserts module identity, not the absence of an error.** After
  loading, it compares the plugin's resolution of `@nestjs/common` against the
  host's own and refuses to register the plugin when they differ. A duplicate
  copy can appear to work for simple decorators and fail much later.
- **Malformed or failing plugins are skipped and reported**, never fatal to
  boot. A broken plugin must not be able to take the association's register
  offline.

### Spike outcome (measured 2026-08-27)

Verified empirically on Node 26.7.0 with `@nestjs/common` 11.2.3, loading a
CJS plugin bundle from a directory outside the repository:

- **`peerDependencies` alone does nothing at runtime.** With no bridge, the
  plugin failed with `MODULE_NOT_FOUND: Cannot find module '@nestjs/common'`.
  Node's CJS resolution walks up from the plugin's own directory
  (`/data/plugins/node_modules/<plugin>/`) through `/data/plugins`, `/data`
  and `/`, and can never reach the application's `node_modules`. The original
  plan's assumption was wrong in exactly the way predicted.
- **The `NODE_PATH` bridge works and yields a single instance.** With
  `NODE_PATH` pointed at the API's `node_modules`, the plugin loaded and the
  object it resolved was **identical** to the host's (`===` on both the module
  namespace and the `Module` decorator itself), confirming one shared NestJS
  instance rather than two compatible-looking copies.
- **`NODE_PATH` is only a fallback, so a sibling copy wins.** With a duplicate
  `@nestjs/common` placed next to the plugin, resolution picked the duplicate
  and never consulted `NODE_PATH`. In the spike it then failed on the
  duplicate's own missing transitive dependency; in a real install the
  transitive dependencies would be present and the duplicate would load
  silently. This is why `--omit=peer` plus the identity assertion are both
  required: either one alone is insufficient.
- **`npm install --prefix` prunes packages it does not know about.** Running
  `npm install @nestjs/common --prefix /data/plugins` reported
  "added 18 packages, and removed 1 package" and **deleted the already
  installed plugin**, because that plugin was not listed in the directory's
  `package.json`. Installing plugin B would therefore uninstall plugin A. The
  loader must own that `package.json` and install from a complete dependency
  set.

## Consequences

- The API process must be started with `NODE_PATH` set. This is part of the
  container entrypoint and the dev scripts, not something the operator
  configures.
- The install job is a sequence with a defined commit point: download,
  verify the sha512, install into a staging directory, move atomically into
  `/data/plugins`, mark the pg-boss job complete and await the database
  commit, drain in-flight HTTP, then exit for the supervisor to restart. The
  job must be idempotent so a crash at any step converges on the next boot;
  otherwise the install job re-runs after every restart and the container
  loops.
- pnpm is not used for plugin installation. Its isolated layout makes the
  resolution assumptions above unreliable, so the runtime installer uses npm,
  and the production image must therefore contain the npm CLI (slim and
  distroless bases may not).
- Frontend loading is unaffected by these findings and stays on Module
  Federation 2.0 via the official `@module-federation/vite`. Note the
  remote-side constraint: remotes cannot be served by a plain `vite dev`
  server, so plugin frontend development uses `vite build --watch` with
  `vite preview`.

## Revisit triggers

- **A JS sandbox becomes viable** (`isolated-vm` is in maintenance mode today;
  QuickJS in WebAssembly is the alternative track): revisit the whole trust
  model, which currently rests on catalog curation plus permission enforcement
  in the SDK layer, with backend plugins running at full process privilege.
- **Node changes CJS resolution or `NODE_PATH` handling**, or the plugin
  bundles move to ESM: re-run the identity spike, since ESM resolution does
  not honour `NODE_PATH`.
- **Plugin count per instance grows** to where boot-time loading is slow:
  reconsider lazy registration, keeping in mind the known NestJS
  `LazyModuleLoader` issues with nested dynamic modules.
