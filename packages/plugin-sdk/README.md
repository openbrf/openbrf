# @openbrf/plugin-sdk

The plugin contract of [Open BRF](https://github.com/openbrf/openbrf), the
platform for Swedish housing cooperatives: the manifest schema, the permission
set, the interfaces of the services an instance hands a plugin, the schema of
the catalog index, and `pluginPackageProblems`, the check a plugin package has
to pass before it is listed.

## Installing

```sh
pnpm add -D @openbrf/plugin-sdk
```

A development dependency. A plugin imports the SDK for its types, and
everything the plugin uses at runtime is injected by the instance; this package
is not resolvable from an installed plugin's directory. `@nestjs/common`,
`@nestjs/core` and `zod` are the plugin's peer dependencies and are never
bundled.

## The contract

This package implements the
[plugin contract](https://github.com/openbrf/openbrf/blob/main/docs/plugin-contract.md):
what a plugin is, what it may do, what an instance does with it, and the format
of the catalog a plugin is installed from.

## Versions

The major version is the plugin API version, `PLUGIN_API_VERSION`. Additive
changes, such as a new optional manifest field or a new method on the host,
keep the plugin API version and are minor releases. Anything a plugin built
against an earlier release could notice raises the plugin API version, and the
major version with it. A plugin that depends on `^1.0.0` therefore stays on the
contract it was built against.

## Starting a plugin

[openbrf/example-plugin](https://github.com/openbrf/example-plugin) is the
reference plugin, built against this package the way any plugin is. Start from
it.

## Licence

AGPL-3.0-only, with the
[Open BRF Module Exception](https://github.com/openbrf/openbrf/blob/main/LICENSE-EXCEPTION.md).
Both texts are in this package, as `LICENSE` and `LICENSE-EXCEPTION.md`. A
plugin that interacts with Open BRF only through the documented extension
interfaces, which this package describes, is a module under that exception: it
is not a work based on Open BRF, and it may be licensed on terms of its
author's choosing, proprietary ones included.
