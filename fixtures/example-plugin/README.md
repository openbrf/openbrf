# @openbrf/example-plugin

The reference Open BRF plugin. It exists to be installed by a test, not by a
housing cooperative, and it exercises every part of the install contract at
once so that a change to any of them fails a test rather than an instance.

## What it proves

| Part of the contract          | How this package exercises it                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Manifest                      | The `openbrf` field of `package.json`, with all four settings field types.           |
| Permissions and personal data | Declares `addressBook:read` and the three categories that reading the register uses. |
| Server entry                  | `dist/server.cjs`, a CommonJS bundle with no `require` call of its own.              |
| Scoped register access        | `GET /summary` and `GET /apartments` read through the host's address book service.   |
| Validated settings            | Both routes read `host.settings.read()` and honour the declared `rowLimit`.          |
| Start-up hook                 | `onStart` writes one line through the host's logger.                                 |
| Client entry                  | `dist/remoteEntry.js`, a Module Federation remote exposing `./View`.                 |
| Runtime translations          | `locales/{sv,en}.json`, merged by the host under the `plugin-occupancy` namespace.   |
| Theming                       | The view styles itself with design tokens only, so a theme restyles it.              |

Neither route declares a capability. The host raises every plugin route to the
floor implied by the plugin's own permissions, so a route that named one could
only ever ask for less than `addressBook:read` already requires.

## How it is built

`node scripts/build-fixture-catalog.mjs` from the repository root, or
`pnpm fixtures:build`. That script builds this package, packs it into
`fixtures/.artifacts/`, and writes `fixtures/catalog/catalog.json` with a
`file:` artifact URL and the tarball's sha512 - which is what lets the
end-to-end harness run the real install path with no network.

The package is not a workspace member and carries its own dependency tree,
installed with `pnpm install --ignore-workspace`. That is the point: a plugin
is built by its own toolchain and installed from a tarball, so anything it
could only do from inside this repository would not be part of the contract.
`@openbrf/plugin-sdk` is a devDependency pointed at the workspace copy, which
is all a plugin ever needs it to be: the SDK carries the types and the manifest
schema for the author's own build, and the host injects everything a plugin
uses at runtime. The packed tarball has no runtime dependencies at all.

Two builds produce `dist/`:

- `tsc -p tsconfig.server.json` compiles `src/server.ts` to CommonJS. Every
  import in that file is `import type`, so the emitted bundle contains no
  `require` call at all - ADR 0003 requires a prebuilt bundle whose only
  externals are host packages, and this one has none.
- `vite build` builds `src/View.tsx` into the remote entry, with `react`,
  `react-dom` and `react-i18next` as shared singletons taken from the host.

The client build is not minified. A fixture is read at least as often as it is
run, and the tarball is generated rather than committed, so nothing is gained
by making the output harder to inspect.
