# Laundry room rules: a sample addon to digital signage

A complete addon to Open BRF's digital signage, written against the published
[`@openbrf/plugin-sdk`](https://www.npmjs.com/package/@openbrf/plugin-sdk) and
nothing else. Start from it when you write your own. What the `source` point
expects is in [Digital signage, "For addon authors"](../../digital-signage.md#for-addon-authors),
and how addons work in general is in the plugin contract's
[Extension points](../../plugin-contract.md#extension-points).

It adds two slides to the rotation of every screen inside the building that the
board switched it on for:

- the laundry room's rules, headed with the address the screen hangs at, such
  as "Laundry room, Storgatan 3";
- the laundry room's opening hours, as a table.

A screen visible from outside the building gets no slides from it.

## What it shows about addons

| Property                               | Where                                                                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Written against the public SDK alone   | `package.json` takes `@openbrf/plugin-sdk` from the npm registry. `src/` imports that package for its types, `@nestjs/common`, which the host shares, and its own files, and the tests check it imports nothing else. |
| A source in the rotation               | `src/rules.ts` contributes to `signage`'s `source` point, version 1, and answers in the point's shapes.                                                                                                               |
| A consent of its own                   | The manifest asks for `addresses:read`, declares no personal data and names what it extends. The board consents to that when it installs the addon, apart from digital signage.                                       |
| Never digital signage's permissions    | The handler reads the addresses under the addon's own `addresses:read`. Digital signage also holds `news:read`, `calendar:read`, `bookings:readAvailability` and `media:read`, and the addon can use none of them.    |
| Off when it or its host plugin is off  | Nothing in the addon: the host stops serving the contribution when either plugin is switched off.                                                                                                                     |
| Its own text, in the screen's language | `locales/sv.json` and `locales/en.json`, read by the handler and merged by the host for the board's screens, where the title and description are shown.                                                               |

Open BRF's own integration test,
`apps/api/src/plugins/plugin-signage-addon-example.int-spec.ts`, installs this
package from a catalog with npm, as an instance does, beside a stand-in for
digital signage. It checks each of these properties against the real host.

## Layout

```
package.json         the manifest under "openbrf"
locales/             the addon's text in Swedish and English, with the same keys
src/entry.cjs        the server entry point the host requires
src/server.ts        the module factory: contributes to the point, nothing else
src/rules.ts         the contribution: the handler and its slides
scripts/build.mjs    bundles dist/server.cjs with esbuild
scripts/catalog.mjs  packs the addon and writes a catalog index that lists it
test/                the handler against a fake host, and the package checks
```

## Building and testing

The directory is a project of its own and is not part of the repository's
workspace, as an addon you write is not.

```sh
pnpm install
pnpm test        # builds dist/server.cjs, then runs the tests
pnpm typecheck
```

The tests load the bundle as the host does, call the handler as digital signage
does, and hold every answer to a strict copy of the point's shapes and limits
(`test/source-schema.ts`), because the host refuses an answer with one string
over its limit or one key the point does not name. They also run the SDK's
`pluginPackageProblems` over the packed file list, which is the check the catalog
runs before it lists a plugin.

## Trying it on an instance

`pnpm catalog` packs the addon into `catalog/` and writes `catalog/catalog-v2.json`,
an index that lists it with its sha512. Point an instance at that index:

```sh
OPENBRF_CATALOG_URL="file:///path/to/catalog/catalog-v2.json"
OPENBRF_UNCURATED_PLUGINS_ENABLED=true
```

The second variable is needed because the index is not the curated catalog. The
addon then appears on the board's plugins screen with its consent screen, and
installs as anything from the catalog does.

The addon serves only beside the `signage` plugin, which is a paid module
([ADR 0034](../../adr/0034-digital-signage-on-the-public-plugin-api.md)). An
instance reads one index, so to install both from it, pass an index that lists
`signage` to `--merge`:

```sh
pnpm catalog --merge /path/to/an/index/listing/signage.json
```

Without the host plugin, the addon is installed and waits, and the plugins screen
says `extension-host-missing`.

`--out` writes elsewhere, and `--url-prefix` sets what the tarball's file name is
appended to in the index, for an instance that reaches the directory at another
address.

## Making it yours

- Give the package your own `name`, and the manifest your own `id`.
- Take `@openbrf/plugin-sdk` at the version your instances run, and leave the
  host's packages under `peerDependencies`. A plugin declares no runtime
  `dependencies`.
- Ask for the permissions your handler needs and no others. If your slides
  carry names or apartments, declare them in `personalData`, in
  `extends[].personalData` and in a `processing` declaration.
- Say in `source.description` what the addon shows and to whom. The board reads
  it when it switches the addon on for a screen.
- List it in the [catalog](https://github.com/openbrf/catalog) by a pull request.

Under the [Open BRF Module Exception](../../../LICENSE-EXCEPTION.md), an addon
that uses only the public plugin API is not a work based on Open BRF, and you
choose its licence.
