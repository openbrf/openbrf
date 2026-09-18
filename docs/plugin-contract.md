# The plugin contract

What a plugin is, what it may do, and what an Open BRF instance does with it.
This document is the reference for plugin authors; the resolution strategy
behind it is recorded in [ADR 0003](adr/0003-plugin-loading-and-module-resolution.md).

The current contract version is **1**. A plugin declares the version it was
built against, and an instance refuses to load one built against a version it
does not implement.

## What a plugin is

An npm package, distributed as a tarball, that contributes any of:

- **A NestJS module**, imported into the application at start-up. Its
  controllers are mounted under `/api/plugin/<id>/`; its providers, guards and
  lifecycle hooks are the framework's own.
- **A view**, a React component the browser loads at runtime through Module
  Federation and renders inside the application frame.
- **Background work**, on queues the host namespaces to the plugin.
- **Settings**, declared rather than drawn: the host renders the form and
  validates the values.

A plugin never opens a port and never draws a settings screen of its own.
Every route it contributes is mounted by the host, under the host's prefix and
inside the host's authorization guard, so a plugin's endpoint can never be the
one on an instance that skipped the session check.

## The manifest

The manifest is the `openbrf` field of the package's own `package.json`. It
lives there rather than in a separate file because npm already installs
`package.json`, already validates its name and version, and already refuses a
package without one - a second manifest file could go missing, disagree with
the package it sits in, or be left behind by a partial extraction.

```jsonc
{
  "name": "@example/openbrf-occupancy",
  "version": "1.0.0",
  "files": ["dist", "locales"],
  "openbrf": {
    "apiVersion": 1,
    "id": "occupancy",
    "entry": {
      "server": "./dist/server.cjs",
      "client": "./dist/remoteEntry.js",
    },
    "permissions": ["addressBook:read"],
    "personalData": ["name", "apartment", "residency"],
    "view": { "module": "./View", "titleKey": "view.title" },
    "settingsSchema": {
      "fields": [
        {
          "key": "heading",
          "labelKey": "settings.heading.label",
          "type": "text",
          "default": "Occupancy",
        },
      ],
    },
    "actions": [
      {
        "id": "summary",
        "capability": "addressBook:read",
        "effect": "read",
        "personalData": [],
        "surfaces": ["ui", "mcp"],
      },
    ],
  },
}
```

| Field                    | Required       | Meaning                                                                                                                                                    |
| ------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiVersion`             | yes            | The contract version. Currently `1`.                                                                                                                       |
| `id`                     | yes            | Lowercase letters, digits and single hyphens. It becomes a URL segment, an i18n namespace, a database key and a directory name, so no dots and no slashes. |
| `entry.server`           | one of the two | Prebuilt CommonJS bundle exporting `createPlugin`.                                                                                                         |
| `entry.client`           | one of the two | Module Federation remote entry.                                                                                                                            |
| `permissions`            | no             | What the plugin asks the host for. Empty by default.                                                                                                       |
| `personalData`           | no             | Which categories of personal data it will handle. Shown on the consent screen.                                                                             |
| `view`                   | no             | The exposed module name and the i18n key for its title.                                                                                                    |
| `settingsSchema`         | no             | The settings form the host renders.                                                                                                                        |
| `actions`                | no             | What the plugin proposes the platform be able to do. At most sixteen, shown on the consent screen.                                                         |
| `oauthProtectedResource` | no             | The route, under this plugin's own mount, that serves MCP. At most one installed plugin may declare it.                                                    |

Entry paths are relative and may not step outside the package.

One action is an `id` (lowercase letters, digits and underscores, three to
thirty-two characters), the single `capability` it needs, its `effect` - `read`,
`write` or `delete` - the `personalData` categories it can touch, and the
`surfaces` it may be offered on. The last two default to `[]` and `["ui"]`. The
capability, the effect, the categories and the surfaces are declared here rather
than in the bundle because the board reads them on the install consent screen,
before anything has been downloaded; the bundle supplies only the schemas, the
text keys and the handler.

The public name is composed by the host: the plugin's id with dashes folded to
underscores, an underscore, then the action's id. A pair that composes to more
than sixty-four characters is manifest-invalid, and the folding means a plugin
`a-b` declaring `c` collides with a plugin `a` declaring `b_c` - the second to
arrive is refused. [Actions](actions.md) has the arithmetic and the rest of what
an action must meet.

One category has a consequence worth knowing before you write the manifest.
`protected` marks an action that can return a field of a person carrying
protected personal data (skyddade personuppgifter), and an action declaring it
may not list `mcp` or `ai` among its surfaces - so it is offered on the
platform's own screens and to your own routes, and nowhere beyond the instance.
It is refused twice, from the manifest at install and again when the definition
is registered.

Read as a rule about what to bind rather than what to declare, it means an
action worth offering is one that cannot return such a field at all. That is a
property of the method your handler calls rather than of your declaration, and
for the register it is already settled: a plugin has never been able to read a
protected person at all. The rule below - not masked, absent - is what makes
`protected` the wrong declaration for a plugin's register read rather than the
cautious one.

A withheld value is published as a different shape, never as an empty one: a
discriminated union over strict objects, each branch described. A caller that is
a model reading `""` or `null` concludes the association holds nothing, while one
reading a branch named `protected` concludes the value is withheld.

`oauthProtectedResource` is written without a leading slash, in lowercase path
segments, and the host joins it onto the plugin's own mount: a plugin `connector`
declaring `"mcp"` serves the resource at `/api/plugin/connector/mcp`. Declaring
it has three consequences worth understanding before doing so.

The route's full URL becomes the instance's OAuth protected resource. It is the
audience every access token is issued for, the address both discovery documents
point at, and the value a client must send as `resource` - a token minted for
anything else is refused. The route therefore also stops accepting the browser's
session cookie: it accepts a Bearer token issued for it and nothing else, and so
does every path beneath it.

At most one installed, enabled plugin may declare it. An install is refused
outright when another installed plugin already declares one, and if two ever
reach the volume the one installed first keeps it while the newcomer carries
`oauth-resource-conflict`. Moving the audience would strand every connection the
members have already granted, so it is never moved automatically.

The plugin id `mcp-connector` is reserved. An instance that has no connector
installed still advertises `/api/plugin/mcp-connector/mcp` as its resource, so
that sign-in is configurable and discoverable on a bare instance; nothing is
mounted there and no Bearer route exists. A plugin may take that id only if its
manifest declares `oauthProtectedResource`, and the install is refused otherwise

- without that, installing an unrelated plugin that happened to claim the id and
  serve `mcp` would silently convert a real route into a Bearer-only one.

## Permissions

| Permission                | Grants                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `addressBook:read`        | Apartments, names, who is a resident and who is a member, and move-in and move-out dates. |
| `addressBook:readContact` | Additionally email addresses and telephone numbers.                                       |
| `mail:send`               | Sending mail through the instance's configured SMTP server.                               |
| `sms:send`                | Sending text messages through the instance's configured SMS provider.                     |
| `jobs:schedule`           | Registering workers and enqueuing or scheduling jobs.                                     |

An instance configures an SMS provider or does not, and one that has not cannot
send at all: `host.sms.send` fails rather than dropping the message, the same
way the core's own SMS mailing does. Having no provider is the ordinary state of
a housing cooperative that only ever mails its members, so a plugin whose work
depends on SMS should read `host.permissions` and degrade, or treat the failure
as the answer. The message is sent as the plugin wrote it, under the sender name
on the housing cooperative's provider contract; the host adds nothing to the
body, because a text message is billed by its length.

Three rules hold on every register read regardless of what a plugin asked for,
because they are the product's own and a plugin is not a reason to relax them:

- **A person with protected personal data (skyddade personuppgifter) never
  appears.** Not masked - absent.
- **A personal identity number is never returned.** No permission grants it and
  there is no method that could.
- **Nothing is writable.** A plugin that needs to change resident data is a
  core feature request, not a plugin.

Permissions are not a sandbox. A backend plugin's code runs at full process
privilege; catalog curation is what stands between an instance and hostile
code, and these permissions are what the board consents to and what the SDK
enforces against an honest plugin reaching further than it said it would. ADR
0003 records the trigger for revisiting that.

The consented set is a snapshot taken at install time. A republished version
asking for more than the board agreed to is refused at load and reported on
the admin screen; reinstalling it shows the new declaration for consent.

## Where the plugin sends personal data

The manifest cannot answer this one, so the consent screen asks the board.

A plugin is not a data processor by default. It runs inside the instance's own
process, on the association's own server, and code that sends nothing anywhere
receives nothing on the association's behalf - there is no recipient, and GDPR
art. 28 wants an agreement with a recipient. So the install step asks the single
question the instance cannot settle for itself: does this plugin send personal
data outside the instance, and if so to whom.

"No" records the plugin as a recipient that is not a processor, with the reason
written down. "Yes" names the recipient and asks the board to classify it - a
service acting on the association's instructions is a processor and needs an
agreement with the terms art. 28(3) requires and the prior authorisation of
sub-processors art. 28(2) requires; one deciding its own purposes is an
independent controller, which needs no such agreement. Either way the answer
lands in the association's record of who receives personal data, next to the
SMTP server, the SMS provider and the object storage.

Installing a plugin also writes it into the record of processing activities
(art. 30) with the categories the manifest declared, and removing one closes
that processing while leaving the recipient's classification standing for the
board to close: the plugin is gone, the fact that it once received data is not.

The command-line tool answers neither question. Running the command is the
consent, and there is no screen for a board to classify anything on, so the
plugin reads as a recipient nobody has classified until somebody answers on the
admin screen. That is the honest state rather than a silent "not a processor".

## The server entry point

A **prebuilt CommonJS bundle** whose only externals are host packages. It
exports `createPlugin`, which receives the host object and returns a NestJS
`DynamicModule`.

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

`@nestjs/common`, `@nestjs/core` and `zod` are **peer dependencies**. Declare
them as such and never bundle them: the host puts its own `node_modules` on
`NODE_PATH` so a plugin resolves the one running instance, and it refuses to
register a plugin that resolved a second copy (ADR 0003).

The two have different reasons. A second copy of NestJS is not a duplicate but a
second and disconnected system - its own container, its own metadata registry -
and it breaks dependency injection in ways that surface long after the install
looked successful. zod holds no state at all and is shared for a reason about
identity: an action's schemas cross from the plugin into the host, which converts
them into the JSON Schema a caller is published and validates against them on
every call. A schema built with a bundled copy comes from a second realm, which
the host cannot read, so it is refused.

Everything else must come from `@openbrf/plugin-sdk` as a **type-only** import.
The SDK is a build-time dependency: everything a plugin uses at runtime is
injected by the host, and the package is not resolvable from an installed
plugin's directory.

Build with `experimentalDecorators` and `emitDecoratorMetadata`. NestJS
resolves a provider's constructor arguments from the metadata those emit, and
a plugin built without them ships controllers whose dependencies cannot be
resolved.

CommonJS, not ESM. Only CJS resolution honours the `NODE_PATH` bridge that
lets a plugin reach the host's packages at all.

### When the host object is usable

The module factory runs before the application exists, so the object it
receives is late-bound: its services resolve when they are used. They are live
from `onModuleInit` onwards - from a lifecycle hook, a guard or a request
handler - and not from a provider's constructor, which is where NestJS asks
for start-up work in any case. A call made too early throws
`PluginHostUnavailableError` rather than reading a half-built application.

The same error is thrown after the board switches the plugin off. Its module
stays constructed until the next boot, so a timer or job worker it started of
its own keeps running, and must not still be reading the register.

`host.actions.register` is the one exception. It is callable from the module
factory, because a declaration is not work: a registration made that early is
buffered and flushed into the registry once the application exists, inside the
same window the other services are bound in. `host.actions.list` and
`host.actions.invoke` keep the ordinary gate, and need no exception - a route
serving a request means the application is up.

### Actions

An action is one thing the platform can be asked to do, dispatched through one
place that checks the calling person's capability on every call. A plugin
declares its actions in the manifest and registers the matching definitions -
the schemas, the text keys and the handler - from its module factory. What an
action's name, description, schemas and refusals must meet is in
[Actions](actions.md).

```ts
host.actions.register({
  id: "summary",
  definition: {
    name: "summary",
    titleKey: "actions.summary.title",
    descriptionKey: "actions.summary.description",
    group: "occupancy",
    groupTitleKey: "actions.group.occupancy.title",
    idempotent: true,
    additive: false,
    needsConfirmation: false,
    openWorld: false,
    errors: [],
    input: z.strictObject({}).describe("Takes no arguments."),
    output: z.strictObject({ apartments: z.number().int() }),
    handler: async () => host.addressBook.summary(),
  },
});
```

Text keys are written bare and the host qualifies them into the plugin's own
namespace. An id the manifest does not declare is refused, and so is a schema
that cannot be published; either stops the plugin serving and is reported as
`action-refused`.

Neither `list` nor `invoke` takes a person. Both take the request the plugin's
own route received, and the caller is read from a mark the host put on it, so a
plugin dispatches as whoever is on the other end of the request it is serving and
cannot dispatch as anybody else.

**Declaring an action is a proposal.** It reaches connected apps and the AI
package only once an administrator arms it, individually, on the plugin's own
screen - the same authority that installed the plugin and consented to what it
may do. Arming is read at the moment of the call, so disarming bites at once, and
it is cleared whenever the board consents to a republished version: an action
that keeps its id while changing the capability it needs is a different action
wearing the same name. Re-arming after an upgrade is one toggle. A plugin's own
route may reach its own actions without any of this, because that is in process.

`host.actions` was added after this contract version shipped, so a plugin built
against a newer host than the one it runs on must feature-detect:

```ts
if (host.actions === undefined) {
  // This instance is older than the member. Do without it.
}
```

`isSupportedApiVersion` cannot see a member added to an interface, so nothing
refuses such a plugin at load. Without the check the failure surfaces as a
`load-failed` finding whose message is deliberately withheld from the board and
written to the server log instead.

### Routes

Controllers are mounted under `/api/plugin/<id>/` whatever path they declare,
inside the application's authorization guard. Each is raised to the capability
floor implied by the plugin's own permissions, so a plugin that reads the
register cannot expose that reading to a caller the core would not let read
it. A controller may require **more** with `@RequireCapability`; it cannot
require less, and `@Public()` on a plugin route has no effect.

A handler that throws is answered as a bad gateway and logged with the
plugin's id. A handler that throws an `HttpException` of its own is answered
with what it asked for.

### What a plugin's module may not do

A NestJS module can declare things whose effect is application-wide. A module
doing any of the following is refused at load and reported on the admin
screen, the same way a malformed manifest is:

- providing `APP_GUARD`, `APP_INTERCEPTOR`, `APP_FILTER` or `APP_PIPE`, which
  would act on the application's own routes;
- registering middleware through `NestModule.configure`, for the same reason;
- declaring itself `@Global()`, which would export its providers into every
  module in the application;
- declaring a controller or route path that steps outside the plugin's prefix.

Guards, interceptors, filters and pipes scoped to the plugin's own
controllers - `@UseGuards` and the rest - are unaffected. They narrow what
reaches a handler and cannot widen it.

## The client entry point

A Module Federation 2.0 remote, built with `@module-federation/vite`. The
remote's name must be the plugin's id, and the exposed module must match the
manifest's `view.module`.

`react`, `react-dom`, `react-i18next` and `i18next` must be declared as shared
singletons with `requiredVersion: false`. A second copy of React gives the view
its own hook dispatcher, and a second copy of i18next gives it a resource store
the plugin's own translations were never merged into.

Remotes cannot be served by a plain `vite dev` server. Plugin frontend
development uses `vite build --watch` with `vite preview`.

### Styling a view

A plugin's view is themed by the same token contract as the rest of the
interface (`docs/theme-contract.md`), so a theme restyles it along with
everything else. There is one constraint that follows from how the stylesheet
is built: the application's CSS is generated from the application's own source,
so a Tailwind utility class a plugin uses exists only if the application
happens to use it too. A plugin that needs something outside that set should
reference the `--obrf-*` custom properties directly, from its own stylesheet or
an inline style, rather than reaching for a utility class that may not be
there.

A hardcoded colour is a defect in a plugin for the same reason it is one in the
core: it survives a theme change, and the association's own is then the only
thing on the screen that does not.

The bundle is served from the instance's own origin at
`/api/plugins/<id>/client/`, behind the session. Only JavaScript, CSS, JSON,
source maps, images and `woff2` fonts are served; the rest of the package -
the server bundle, the locale files, the manifest - is not reachable over
HTTP.

## Translations

A plugin ships `locales/sv.json` and `locales/en.json`, with identical key
sets. The host merges them at runtime under the namespace `plugin-<id>`, on
the server and in the browser alike, so a plugin's keys can never collide with
the core's. The browser fetches them lazily from
`GET /api/i18n/:lng/:ns`.

Swedish is the product's default language and English has full parity. Every
user-visible string a plugin renders goes through a key; a plugin that ships
no readable locale file renders its keys, which is visibly wrong rather than
silently blank.

## Settings

A plugin declares fields and the host renders the form, validates the values
against the same declaration on write, and hands them back through
`host.settings.read()` with the declared defaults applied.

| Type      | Extra fields                                           |
| --------- | ------------------------------------------------------ |
| `text`    | `default`, `minLength`, `maxLength`                    |
| `number`  | `default`, `min`, `max`, `integer`                     |
| `boolean` | `default`                                              |
| `select`  | `default`, `options` (each a `value` and a `labelKey`) |

Every field carries a `key` (a lowerCamelCase identifier), a `labelKey` and an
optional `hintKey`. Labels are i18n keys in the plugin's own namespace, not
inline text: a manifest carrying English prose would put an untranslatable
string on a Swedish-first screen.

`host.settings.read()` reads the current values on every call rather than
caching, so a value changed in the admin interface reaches a long-running
worker without a restart. A value whose field no longer exists is stripped.

## Distribution and installation

An instance never contacts a package registry. The catalog lists direct
tarball URLs with a sha512, and the install job downloads, verifies, and
installs from the local file.

```jsonc
{
  "version": 1,
  "entries": [
    {
      "type": "plugin",
      "id": "occupancy",
      "packageName": "@example/openbrf-occupancy",
      "version": "1.0.0",
      "apiVersion": 1,
      "name": { "sv": "...", "en": "..." },
      "description": { "sv": "...", "en": "..." },
      "permissions": ["addressBook:read"],
      "personalData": ["name", "apartment", "residency"],
      "artifact": {
        "url": "https://example.com/occupancy-1.0.0.tgz",
        "sha512": "sha512-...",
        "bytes": 89408,
      },
    },
  ],
}
```

The digest may be written as `sha512-<base64>` (what `npm pack --json`
reports) or as 128 hex characters (what `sha512sum` prints). A tarball whose
digest does not match is discarded, never unpacked.

An install is a sequence with a defined commit point: download, verify,
install into a staging directory, move it into place, mark the job complete
and wait for that to commit, drain in-flight HTTP, exit. A supervisor started
with `restart: unless-stopped` brings the process back. The whole flow is
idempotent - the database holds the desired state and `/data/plugins` is
reconciled to it - so a crash at any step converges on the next run rather
than leaving the two disagreeing.

Installing a plugin therefore restarts the application. Removing one does too,
and so does switching one back on - a plugin's module has to be in the graph
when the application is built, and NestJS cannot add one to a running
application with its controllers. Switching a plugin **off** does not restart
anything: it stops serving immediately.

## Operator configuration

| Variable                            | Default           | Effect                                                                                     |
| ----------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `OPENBRF_PLUGINS_ENABLED`           | `true`            | When false, nothing is loaded or installable.                                              |
| `OPENBRF_CATALOG_URL`               | the curated index | Where the catalog is read from.                                                            |
| `OPENBRF_CATALOG_TOKEN`             | unset             | Bearer token for the index and its release assets.                                         |
| `OPENBRF_UNCURATED_PLUGINS_ENABLED` | `false`           | Required to point `OPENBRF_CATALOG_URL` anywhere but the curated index.                    |
| `OPENBRF_PLUGINS_REINSTALL_ON_BOOT` | `false`           | Reinstall at boot when the data volume does not carry what the database says is installed. |

The `openbrf` command-line tool drives the same install as the admin screen:

```
openbrf plugin list
openbrf plugin catalog
openbrf plugin add <id>
openbrf plugin remove <id>
```

The production image must carry the npm CLI. pnpm is not used for plugin
installation: its isolated layout makes the resolution assumptions above
unreliable (ADR 0003).

## When a plugin does not load

A malformed or failing plugin is skipped and reported, never fatal. A broken
plugin must not be able to take the housing cooperative's statutory registers -
the member register and the apartment register - offline. The admin screen
lists everything on the data volume that is not running and why:

| Reason                    | Meaning                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `manifest-invalid`        | The `openbrf` field failed validation.                                 |
| `api-version-unsupported` | Built against a contract version this instance does not implement.     |
| `entry-missing`           | A declared entry file is not in the package.                           |
| `entry-invalid`           | The server bundle does not export `createPlugin`.                      |
| `module-invalid`          | `createPlugin` returned no NestJS dynamic module.                      |
| `module-refused`          | Its module declares behaviour a plugin may not register.               |
| `module-failed`           | Its module could not be built into the application.                    |
| `module-identity`         | The package carries its own copy of a host package it must share.      |
| `permissions-widened`     | It asks for more than was consented to.                                |
| `personal-data-widened`   | It handles a personal-data category not consented to.                  |
| `actions-widened`         | It declares an action the board has not consented to.                  |
| `action-refused`          | An action it declares could not be registered.                         |
| `forbidden-injection`     | One of its providers reaches for a core service a plugin may not hold. |
| `oauth-resource-conflict` | Another installed plugin already serves the OAuth protected resource.  |
| `not-consented`           | On the volume with no record of consent.                               |
| `disabled`                | Switched off in the admin interface.                                   |
| `load-failed`             | It threw while being loaded.                                           |
| `not-on-volume`           | Recorded as installed but not present.                                 |

Four of these need an answer rather than a restart:

- `actions-widened` is the same gate `permissions-widened` and
  `personal-data-widened` are. The board consented to a stated set of actions,
  compared by the whole declaration rather than by id, so a republished version
  that keeps an id while changing the capability it needs has widened its reach.
  Reinstalling shows the new declaration for consent; arming starts from nothing
  afterwards.
- `action-refused` means a declaration the board did consent to could not be
  registered. The finding names the action id; the reason - a name the instance
  will not take, a capability a plugin's action may not ask for, a schema that
  cannot be published - is in the server log, and the fix belongs to the author.
- `forbidden-injection` means one of the plugin's providers asks NestJS for a
  core provider. Everything the platform's twelve `@Global()` modules export is
  in the root injector - the database, the audit log, the principal service, the
  mailer, the text-message sender, the job queue, the field encryption, the
  instance's configuration - and a plugin may hold none of them, so the module is
  refused rather than loaded. Three of those are offered to you already, narrowed:
  `host.mail`, `host.sms` and `host.jobs` carry the permission check the board
  consented to and stamp your plugin's id on what they send and enqueue, which is
  what injecting the service directly would go around. The injector handles -
  `ModuleRef`, `ModulesContainer`, `Reflector`, `DiscoveryService`,
  `LazyModuleLoader`, `HttpAdapterHost` - are refused for the same reason, since
  resolving a provider by token reaches every name on the list without declaring
  one. A token is matched by name whether it is a class, a symbol or a string.
  The fix belongs to the author.
- `oauth-resource-conflict` means the plugin declares `oauthProtectedResource`
  and another installed, enabled plugin already does. At most one may: the
  resource's full URL is the audience every issued token is bound to, so moving
  it would make every connection a member has already granted stop working. The
  plugin installed first keeps it and the newcomer carries the finding. The
  answer is to remove the other connector, not to reinstall this one.

The set is exported as `PLUGIN_FINDING_REASONS` from `@openbrf/plugin-sdk`. A
finding carries one of these codes and a `detail` object holding the values its
sentence needs - a version number, a file name, the categories a republished
package added - and never a sentence of its own: the admin screen is Swedish by
default while the server is English throughout, so the wording belongs to the
interface. English prose about a refusal goes to the server's log, where the
person debugging the package is reading.
