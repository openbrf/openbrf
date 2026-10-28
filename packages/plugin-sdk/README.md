# @openbrf/plugin-sdk

The plugin contract of [Open BRF](https://github.com/openbrf/openbrf): the
manifest schema, the permission set, the interfaces of the services the host
hands a plugin, and the schema of the catalog that lists plugins and themes.

The major version is the plugin API version. Anything a plugin could notice
raises it, and an additive change keeps it. There is one exception: a security
fix that only refuses a use of the host beyond what the contract grants keeps
the major. Its release notes call it a change to the plugin contract and name
the plugins that break. 1.x is API version 1.

## Installing

```sh
npm install --save-dev @openbrf/plugin-sdk
```

A development dependency, never a dependency. An instance installs a plugin
offline from its verified tarball and refuses a `package.json` that declares
any `dependencies`. Nothing in this package has to resolve at runtime: the host
passes everything a plugin uses in through `PluginHost`, so a plugin imports
the SDK for types and for the checks its own CI runs.

`@nestjs/common` 12 is a peer dependency. A plugin declares `@nestjs/common`,
`@nestjs/core` and `zod` as peer dependencies too, and never bundles them; the
host supplies the running copies.

## The server entry

A prebuilt CommonJS bundle that exports `createPlugin`. It receives the host
object and returns a NestJS module, whose controllers the host mounts under
`/api/plugin/<id>/`, inside the application's authorization guard.

```ts
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import type { PluginModuleFactory } from "@openbrf/plugin-sdk";

export const createPlugin: PluginModuleFactory = (host) => {
  @Injectable()
  class OccupancyService {
    async summary() {
      return host.addressBook.summary();
    }
  }

  @Controller()
  class OccupancyController {
    constructor(private readonly service: OccupancyService) {}

    @Get("summary")
    async summary() {
      return this.service.summary();
    }
  }

  @Module({})
  class OccupancyModule {}

  return {
    module: OccupancyModule,
    controllers: [OccupancyController],
    providers: [OccupancyService],
  };
};
```

## Checking a plugin before it is published

The checks an instance runs at install and at boot are exported, so a
plugin's CI refuses what an instance would refuse:

- `assertPluginPackage(packageJson)` throws with every problem in the
  manifest at once; `parsePluginPackage` returns them instead.
- `pluginPackageProblems(contents)` takes the parsed `package.json`, the file
  list, the server bundle's source and the two locale files, and returns every
  problem that would stop the package installing or loading, one sentence
  each.
- `catalogEntrySchema` is the schema of the entry a listing adds to the
  catalog.

## Documentation

- [The plugin contract](https://github.com/openbrf/openbrf/blob/main/docs/plugin-contract.md):
  the manifest, permissions, personal data, the server and client entries,
  settings, translations, distribution and installation.
- [ADR 0003](https://github.com/openbrf/openbrf/blob/main/docs/adr/0003-plugin-loading-and-module-resolution.md):
  how a plugin is loaded and how it resolves the host's packages.
- [ADR 0020](https://github.com/openbrf/openbrf/blob/main/docs/adr/0020-the-public-catalog-and-the-published-packages.md):
  the public catalog and the published packages.

## Licence

AGPL-3.0-only, with the
[Open BRF Module Exception](https://github.com/openbrf/openbrf/blob/main/LICENSE-EXCEPTION.md).
A plugin that reaches the core only through the documented extension
interfaces is a module under that exception and may be licensed on any terms.
Both texts are in the package.
