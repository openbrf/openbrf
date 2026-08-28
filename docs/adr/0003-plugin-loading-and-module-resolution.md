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

### The contract

- **Plugins ship a prebuilt CJS bundle** whose only externals are the host
  packages. `require` of that bundle yields a `createPlugin` factory that
  receives a host-injected, permissions-scoped SDK object and returns a NestJS
  `DynamicModule`. A plugin's controllers, providers, guards and lifecycle
  hooks are the framework's own.
- **Plugin modules are loaded before `NestFactory.create` and imported into
  `AppModule`.** NestJS registers controllers only for the modules present when
  the container is built; a module added afterwards through
  `LazyModuleLoader` contributes providers and nothing else, so a plugin
  registered post-boot would serve no routes at all.
- **Boot is the only moment a plugin is ever loaded**, and that follows from
  the install flow rather than constraining it. Installing or removing a plugin
  ends by replacing the process (see the sequence under Consequences), so what
  runs is always what is on the data volume when the process starts. Enabling a
  plugin that is not loaded restarts for the same reason. Themes install
  without a restart; plugins do not.
- **The host object is late-bound.** A plugin's factory runs before the
  application exists, so what it receives resolves the application's services
  when they are used rather than when it is built. They are bound once, between
  `NestFactory.create` and `app.init()` - after every provider has been
  constructed and before any lifecycle hook or request handler runs. A plugin
  may therefore use the host from `onModuleInit` onwards and not from a
  constructor, which is where NestJS asks for start-up work in any case. A call
  made too early throws a named error rather than reading a half-built
  application.

### What the host keeps over a plugin's module

A plugin's module is checked and rewritten before it is handed to NestJS.
Registering an unmodified third-party module would hand it the framework's
application-wide reach.

- **Controllers are moved under `/api/plugin/<id>/`**, whatever path they
  declare, so a plugin cannot register a route that shadows a core one.
- **Each controller is raised to the capability floor its plugin's declared
  permissions imply**, merged into whatever the controller asked for so the
  floor can be exceeded and not lowered. The application's own global guard
  enforces the result, and an attempt to mark a plugin route `@Public()` is
  overridden.
- **A module that registers application-wide behaviour is refused**: a global
  guard, interceptor, filter or pipe, middleware, or a `@Global()` module.
  Each of those would act on the core's routes as well as the plugin's.
- **A disabled plugin's routes answer as though it were not installed**, and
  every host service it holds refuses. NestJS cannot remove a route from a
  running router, so a global guard in front of the plugin's controllers is
  what makes switching one off take effect without a restart.

### Resolution

- **Bridge host module resolution with `NODE_PATH`** set at process start to
  every directory the shared host packages resolve from - one per package, not
  one in total. Under npm's flat tree that is a single directory; under pnpm's
  isolated store each package has its own, and bridging only the first would
  leave a plugin able to resolve `@nestjs/common` and not `@nestjs/core` in
  development while working in the image. CJS `require` honours `NODE_PATH`,
  which is what the plugin bundles use.
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
  offline. This covers the module a plugin contributes as well as its package:
  a module whose providers do not resolve fails the whole container, so the
  bootstrap drops the plugin NestJS names in the error and builds the
  application again.

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
- The boot sequence is fixed and shared with the integration suite: bridge
  resolution, read the consent rows, scan the volume, load and seal each
  consented plugin's module, build the application around them, bind the host
  objects, listen. The consent rows are read through a short-lived database
  client of its own, because they decide which bundles may be executed at all
  and nothing that can refuse a plugin may run after the code that executes it.
- A plugin's providers are constructed while the container is built, which is
  before the host object answers. The contract is therefore that host services
  are available from `onModuleInit` onwards; a plugin doing work in a
  constructor gets a named error saying so.
- Switching a plugin off does not unload it. Its module stays constructed and
  its code stays in this process's module cache until the next boot, which is a
  property of loading CommonJS at all. What it can reach the association's data
  through does not: the host object refuses once the plugin stops serving, so a
  timer or job worker it started of its own loses the register with it.
- A plugin's own controller failure is answered as a bad gateway and logged
  with the plugin's id, so an operator can tell a fault in software the
  instance hosts from a fault in the application. A plugin answering with an
  `HttpException` of its own is left alone.
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
  reconsider lazy registration, keeping in mind that `LazyModuleLoader`
  registers providers and not controllers, so a lazily registered plugin would
  need a different way to serve HTTP.
- **NestJS gains a supported way to add or remove a module's controllers on a
  running application**: the global guard in front of a plugin's routes and the
  restart on enabling a plugin both exist because it has none.
