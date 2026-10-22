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
- **Website blocks**, declared in the manifest and rendered on the server:
  the board adds them to the association's pages like any other block, and
  the host decides what of their output reaches a visitor.

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
    "view": {
      "module": "./View",
      "titleKey": "view.title",
      "section": "building",
    },
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
| `personalData`           | no             | Which personal-data categories it will handle. Shown on the consent screen and written into the record of processing activities. See below.                |
| `view`                   | no             | The exposed module name, the i18n key for its title, and the navigation section it is offered in.                                                          |
| `settingsSchema`         | no             | The settings form the host renders.                                                                                                                        |
| `actions`                | no             | What the plugin proposes the platform be able to do. At most sixteen, shown on the consent screen.                                                         |
| `oauthProtectedResource` | no             | The route, under this plugin's own mount, that serves MCP. At most one installed plugin may declare it.                                                    |
| `ai`                     | no             | `true` for an AI package: a language model chooses the actions it dispatches. Its dispatch is recorded on the `ai` channel. See [Actions](#actions).       |
| `personRecords`          | no             | The collections that hold records about a person. See [Records about a person](#records-about-a-person).                                                   |
| `blocks`                 | no             | The blocks it adds to the association's website. At most sixteen; declaring one asks for `site:blocks`. See [Website blocks](#website-blocks).             |
| `licence`                | no             | For a paid plugin: the entitlement it reads, its issuer, the issuer's keys and the services it may present the licence to. See [Licences](#licences).      |
| `released`               | with `licence` | The day this release was published, `YYYY-MM-DD`, compared with a licence's `updatesUntil`.                                                                |

Entry paths are relative and may not step outside the package.

`personalData` names everything the plugin handles, not only what it reads from
the register. A plugin that calls actions handles whatever those actions return,
so an assistant passing issue reports and minutes to a model provider declares
`freeText`, and one that reads charges declares `financial`. The categories are
the ones the association's own record of processing activities uses:

| Category        | Means                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| `name`          | Given and family name.                                                       |
| `apartment`     | Which apartment and address a person is connected to.                        |
| `residency`     | Move-in and move-out dates, and whether the person is a member.              |
| `email`         | Email address.                                                               |
| `phone`         | Telephone number.                                                            |
| `postalAddress` | A postal address of the person's own, not the apartment's.                   |
| `account`       | Sign-in credentials and sessions.                                            |
| `financial`     | Charges, debiting basis, and what a person owes or has paid.                 |
| `health`        | Health, a special category under GDPR art. 9, where somebody has written it. |
| `photograph`    | A photograph, whether or not anybody is recognisable in it.                  |
| `freeText`      | Text a person wrote themselves, which may name anybody.                      |
| `auditTrail`    | The audit log's record of who did what to whose data.                        |

The plugin-level `personalData` list may not name `personalIdentityNumber` or
`protected`: the installer, the catalog check and the install request refuse a
manifest or entry that does. An action's own `personalData` is a separate
declaration and may still name them (`protected` has its own rule, below). A
personal identity number is never returned to a plugin, and a person with
protected personal data never appears in its reads, so a plugin-level
declaration of either would describe something that cannot happen.

Installing the plugin writes these categories into the association's record of
processing activities (GDPR art. 30), as the categories that processing touches.
A declaration narrower than what the plugin actually handles makes that record,
and the consent the board gave, wrong.

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

| Permission                  | Grants                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addressBook:read`          | Apartments, names, who is a resident and who is a member, and move-in and move-out dates.                                                          |
| `addressBook:readContact`   | Additionally email addresses and telephone numbers.                                                                                                |
| `mail:send`                 | Sending mail through the instance's configured SMTP server.                                                                                        |
| `sms:send`                  | Sending text messages through the instance's configured SMS provider.                                                                              |
| `jobs:schedule`             | Registering workers and enqueuing or scheduling jobs.                                                                                              |
| `finances:read`             | The fee notification runs and their notices, the charges to members, and the events that say one was issued or changed. See [Finances](#finances). |
| `finances:recordDelivery`   | Recording that a fee notice or a charge was delivered: a delivery receipt, never a payment. See [Finances](#finances).                             |
| `site:blocks`               | Adding blocks to the association's website, which anybody can read, account or not.                                                                |
| `themes:install`            | Installing and updating themes, for an administrator. See [Installing themes](#installing-themes).                                                 |
| `addressBook:proposeImport` | Handing a member list to the board for review. Not yet in a release; see below.                                                                    |

`site:blocks` excludes both address-book permissions and `finances:read`: a
manifest asking for it beside `addressBook:read`, `addressBook:readContact` or
`finances:read` fails validation. What a block renders is published to the
street, and the website's promise that it cannot publish a resident's details
rests on there being no path from it to the register ([ADR
0006](adr/0006-the-page-block-model.md)); a fee notice and a charge carry the
names of the people they are for. A plugin that reads the register or the
finances and wants a website block is two plugins, or a core feature request.
`addressBook:proposeImport` will be excluded beside `site:blocks` in the same
way, because a plugin that proposes an import holds the member list itself.

An instance configures an SMS provider or does not, and one that has not cannot
send at all: `host.sms.send` fails rather than dropping the message, the same
way the core's own SMS mailing does. Having no provider is the ordinary state of
a housing cooperative that only ever mails its members, so a plugin whose work
depends on SMS should read `host.permissions` and degrade, or treat the failure
as the answer. The message is sent as the plugin wrote it, under the sender name
on the housing cooperative's provider contract; the host adds nothing to the
body, because a text message is billed by its length.

Three rules hold on every register read regardless of what a plugin asked for,
because they are the product's own and a plugin is not a reason to relax them.
The finance reads hold the first two as well, and hold no payment state at all;
[Finances](#finances) says how a withheld person is shown there.

- **A person with protected personal data (skyddade personuppgifter) never
  appears.** Not masked - absent.
- **A personal identity number is never returned.** No permission grants it and
  there is no method that could.
- **Nothing is writable.** A plugin that needs to change resident data is a
  core feature request, not a plugin. The one way a plugin brings data towards
  the register is to propose an import (below), and that writes nothing until a
  board member has reviewed and applied it on the core's own import screen.

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

The question is asked only while the record says nothing about the plugin.
Reinstalling and updating open the same consent step, and so does installing a
plugin that was removed, whose classification stayed standing. There the step
states what the record says and installs without an answer, so the API leaves
the classification as it is: the step asks for a few of the facts the record
holds, and answering it again would replace an agreement the board has since
completed - its date, its reference, the terms it confirmed - with one being
made. A classification that no longer holds is changed on the data protection
screen.

The API holds to that on its own rather than trusting the screen. An install
that carries an answer for a plugin the record already classifies is refused
with `recipient-already-recorded` before anything is written: the permission to
install plugins is not the permission to manage the data protection record, and
a consent screen opened before somebody classified the plugin, or a script
calling the API, must not be able to turn an agreement in place back into one
being made. A classification recorded between that check and the install's own
write is kept, and the install goes on without its answer.

The step asks with no answer chosen, for every plugin, including one that
declares no personal data. The catalog entry says which personal data a plugin
handles, not where it sends it, and a plugin runs at full process privilege
(ADR 0003), so there is nothing for a default to be read from: a pre-selected
"no" would write "passes no personal data on" into the record on the strength of
a click.

Installing a plugin also writes it into the record of processing activities
(art. 30) with the categories the manifest declared, and removing one closes
that processing while leaving the recipient's classification standing for the
board to close: the plugin is gone, the fact that it once received data is not.

The command-line tool answers neither question. Running the command is the
consent, and there is no screen for a board to classify anything on, so the
plugin reads as a recipient nobody has classified until somebody answers on the
admin screen. That is the honest state rather than a silent "not a processor".

## The server entry point

A **prebuilt CommonJS bundle** whose only externals are host packages and
Node's built-in modules. It exports `createPlugin`, which receives the host
object and returns a NestJS `DynamicModule`. A built-in resolves from any
directory, the data volume an installed plugin sits on included; any other
package does not.

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

`@openbrf/plugin-sdk` is a **build-time dependency**: the package is not
resolvable from an installed plugin's directory, so the bundle must not require
it. Its types are erased by the build (`import type`). The few values it exports
(`isActionRefusal`, `ACTION_ERROR_REASONS`, `ACTION_ERROR_MCP`,
`PluginHostUnavailableError` and `RequireCapability`) are plain code, and the bundler inlines them:
import them as usual and bundle the SDK into the plugin.

```ts
import { isActionRefusal, type PluginModuleFactory } from "@openbrf/plugin-sdk";
```

Bundling the SDK does not change the rule above. The SDK imports `zod` itself,
and that import stays external like your own, so the bundle still requires only
`@nestjs/common`, `@nestjs/core`, `zod` and Node's built-in modules. What a
plugin does with the host - the `host` object - is injected, never imported. A
bundled SDK is a second copy of the SDK, so a value that crosses from the host
is recognised by its shape and not by class: use `isActionRefusal`, not
`instanceof`.

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
same window the other services are bound in. `host.actions.list`,
`host.actions.invoke` and `host.actions.client` keep the ordinary gate, and need
no exception - a route serving a request means the application is up.

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

The mark ends with the response. Once the response is sent, or its connection
closes first, the request speaks for nobody, and `list` and `invoke` refuse it:
a request kept and passed again from a job, a timer or another person's request
would otherwise name as the caller someone who is no longer there. Dispatch
before the route returns, and await it.

Nor does either take a channel. The host derives it from how the request arrived
and from the manifest. How the request arrived is what the authorization guard
established when it authenticated the request, kept apart from the request
itself: writing `principal` or `token` on it changes neither the person nor the
channel nor the connected app a dispatch is recorded as.

| The request on the plugin's route | A plugin                   | A plugin declaring `ai`  |
| --------------------------------- | -------------------------- | ------------------------ |
| A signed-in session               | `plugin`, the `ui` surface | `ai`, the `ai` surface   |
| A connected app's token           | `mcp`, the `mcp` surface   | `mcp`, the `mcp` surface |

`host.actions.client(request)` tells a plugin which of the two it is serving: the
connected app the request was authenticated with, as `clientId` and
`clientHost`, or `null` for a signed-in session. It reads what the guard
established, as the dispatch does, so it names the app a dispatch on the same
request is recorded as. A connector asks it before it answers on a route that
must serve connected apps only, and never reads the request's own `token`
property, which the host may change and the plugin can write. Like `list` and
`invoke`, it throws for a request the host did not authenticate.

Declare `ai: true` when a language model chooses what your plugin dispatches.
The audit log then records its writes as made through the AI package rather
than as any plugin's, and it reaches less: only the core actions offered on
`ai`, and a plugin's action - its own included - only once an administrator has
armed it. A listing is of the `ai` surface whatever surface the filter names.
The consent screen tells the board all of this, and a package whose manifest
says otherwise than the board consented to is refused at boot as `ai-changed`.
See [ADR 0038](adr/0038-the-ai-channel-for-a-plugin-s-dispatch.md).

`list` names the actions `invoke` would let the request it is given call, and
each entry carries the action's `inputSchema` and `outputSchema`, as JSON Schema
(draft 2020-12). They are the documents the HTTP catalogue publishes for one
action, the input schema is the one `invoke` validates against, and they are
what an MCP connector puts in `tools/list` or an AI package describes a tool to
a model with. Only the actions listed carry one, so a plugin cannot describe an
action it could not call. Each call builds them afresh, and a plugin may change
what it was handed.

```ts
const tools = (await host.actions.list(request)).map((action) => ({
  name: action.name,
  description: action.description,
  inputSchema: action.inputSchema,
}));
```

A refused call rejects with an `ActionRefusal`, whichever way it was refused.
Recognise one with `isActionRefusal`, not with `instanceof`: the host builds it,
and the copy of the SDK bundled into a plugin is not the host's. Anything else
`invoke` rejects with is a fault rather than an answer.

| Field       | What it carries                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`      | `registry` for the registry's own refusal, `invalid-body` for an input the schema refused, `domain` for the service behind the action |
| `reason`    | One of `ACTION_ERROR_REASONS`, `invalid-body`, or the reason the action declared in its `errors`                                      |
| `status`    | The HTTP status the refusal answers with                                                                                              |
| `transport` | `protocol` or `tool-result`, from `ACTION_ERROR_MCP`                                                                                  |
| `retry`     | `never`, `after-edit` or `after-backoff`                                                                                              |
| `details()` | The particulars: `scopes` for a missing scope, `issues` (path and message, never the value) for an invalid body                       |
| `challenge` | For `insufficient-scope` only, the bearer challenge to send as `WWW-Authenticate`                                                     |

A connector that speaks MCP renders a `protocol` refusal as a JSON-RPC error and
a `tool-result` one as a tool result with `isError` set, and sends `challenge`,
when there is one, on a 403 so the client can ask for the scope it lacks. What
each reason means is in [Refusals](actions.md#refusals).

```ts
try {
  return await host.actions.invoke(request, name, input);
} catch (cause) {
  if (!isActionRefusal(cause)) throw cause;
  if (cause.challenge !== undefined) {
    reply.header("www-authenticate", cause.challenge);
  }
  // Render from cause.transport and cause.retry.
}
```

A route that rethrows the refusal answers with the status, particulars and
challenge the registry's own endpoint would have.

**Declaring an action is a proposal.** It reaches connected apps and the AI
package only once an administrator arms it, individually, on the plugin's own
screen - the same authority that installed the plugin and consented to what it
may do. Arming is read at the moment of the call, so disarming bites at once, and
it is cleared whenever the board consents to a republished version: an action
that keeps its id while changing the capability it needs is a different action
wearing the same name. Re-arming after an upgrade is one toggle. A plugin's own
route may reach its own actions without any of this, because that is in process.
A plugin declaring `ai` is the exception: its dispatch meets the arming as a
connected app's does.

`host.actions` was added after this contract version shipped, so a plugin built
against a newer host than the one it runs on must feature-detect:

```ts
if (host.actions === undefined) {
  // This instance is older than the member. Do without it.
}
```

The schemas on a listing came later than `host.actions` itself. On a host from
before them an entry has no `inputSchema`, so check for it as well:

```ts
const [first] = await host.actions.list(request);
if (first !== undefined && first.inputSchema === undefined) {
  // This instance lists no schemas. Do without them.
}
```

`host.actions.client` came later still:

```ts
if (host.actions?.client === undefined) {
  // This instance cannot say which connected app a request came from.
}
```

`isSupportedApiVersion` cannot see a member added to an interface, so nothing
refuses such a plugin at load. Without the check the failure surfaces as a
`load-failed` finding whose message is deliberately withheld from the board and
written to the server log instead.

### Finances

`host.finances` reads the association's fee notices and charges to members,
records where a plugin delivered one, and tells a plugin when one is issued or
changed. It is the free half of the boundary ROADMAP.md publishes for advanced
finances: recording a charge, issuing notices and reading them are core, and so
is this. What carries a notice or a charge out of Open BRF - an accounting
system, a bankgiro file, a reminder, an approval step - is the plugin's own work.
[ADR 0048](adr/0048-finances-in-the-plugin-api.md) records why it has this
shape.

`host.finances` was added after this contract version shipped, so a plugin must
feature-detect it as it does `host.actions`:

```ts
if (host.finances === undefined) {
  // This instance has no finance API. Do without it.
}
```

#### Reading the books

Under `finances:read`:

| Method                  | Answers                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `notifications()`       | Every fee notification run, newest period first, with its count and total. |
| `notification(id)`      | One run with its notices, or `null`.                                       |
| `charges({ from, to })` | The charges dated in a period, both ends inclusive, as `"YYYY-MM-DD"`.     |
| `charge(id)`            | One charge, or `null`.                                                     |

Every read starts from the rows the board's own files are written from - the fee
notice document and the debiting list - so whatever those files withhold, a
plugin is not given either. On top of that it withholds more, never less:

- **A notice** names the tenant-owners holding the apartment when the period
  closed, as the fee notice file does. Where anybody living in the apartment
  carries protected personal data, or has had processing restricted (GDPR
  art. 18), every name is withheld: `holders` is `{ state: "withheld" }`. The
  apartment and the amount stay, because the apartment is the party the fee is
  fixed on. The fee notice file withholds a protected household's names too,
  and names a restricted one.
- **A charge on a person** names them, with their apartment on the day of the
  charge and the board's reason. Where the person carries protected personal
  data, has had processing restricted, or is no longer in the register, the
  party is `{ kind: "person", state: "withheld" }` and the reason is
  `{ state: "withheld" }`: what the board wrote about a protected person's charge
  can name them as well as a name can. The date, the amount and the VAT
  treatment stay, so the books still add up. The debiting list goes further than
  this - it names a protected person and withholds where they live, because
  whoever keeps the books has to know whom to invoice - and a plugin is not the
  bookkeeper.
- **A charge on an apartment** states the apartment, as the debiting list does.

A withheld value is a different shape, never an empty string, for the reason
[the manifest](#the-manifest) gives. A plugin that delivers notices should treat
a withheld row as one for the board to handle by hand.

No read returns a personal identity number, and none returns a payment, a
balance, a status or anything else that says whether money arrived, because
core records none. `paymentReference` is the number a notice is paid under; it
says nothing about whether it was. Reads are not audited one by one: the plugin
is code the board consented to, running in the instance's own process, and an
entry per poll would bury the entries that say something. What a plugin writes
back is audited.

#### Delivery receipts

Under `finances:recordDelivery`, a plugin records that it delivered a notice or
a charge:

```ts
const receipt = await host.finances.recordDelivery({
  target: { kind: "feeNotice", id: notice.id },
  channel: "fortnox",
  reference: voucher.number,
  deliveredAt: new Date(), // optional; now when left out
});
```

A receipt says that something left the association by a route, at a time, under
the reference the receiving system knows it by. It is not a paid flag and not a
status: it never changes the notice or the charge, a notice may carry several,
and nothing in core reads one to decide anything. Each notice and charge a
plugin reads carries its receipts in `deliveries`, from every plugin, and the
board sees them beside the notice on its own screen. They are never in the file
the board hands over.

On a read, a receipt's `reference` is `{ state: "visible", text }`, or
`{ state: "withheld" }` on a notice whose holders are withheld and a charge
whose party is. That follows the register as it stands at the read, not when
the receipt was recorded: a reference written while a household could be named
can name it as well as the names can, so it goes when they do. The receipt
stays, so a plugin can tell the row was delivered. `recordDelivery` returns the
reference visible, since it is what the plugin has just stated.

- `channel` is lowercase letters, digits and single hyphens, at most 32
  characters: the plugin's own word for the route.
- `reference` is 1 to 128 characters with no control characters. One that holds
  a Swedish personal identity number is refused.
- `deliveredAt` may be earlier than the call and never later.
- The same plugin recording the same target, channel and reference again gets
  the first receipt back, so a job retried after a crash records one delivery
  once.

A refusal is a `PluginDeliveryRefusedError` whose `reason` is one of
`target-not-found`, `channel-invalid`, `reference-invalid`,
`reference-holds-personal-identity-number`, `delivered-at-invalid` and
`delivered-in-the-future`. Compare `error.name` and `error.reason` rather than
using `instanceof`: the SDK is not resolvable from an installed plugin.

Every receipt is written to the audit log as `DELIVERY_RECEIPT_RECORDED`, on the
`PLUGIN` channel, naming the plugin, the route and the receipt but not the
reference. On a charge to a person, that person is the entry's subject, so the
delivery appears on their data subject access report. A receipt is erased with
its notice or charge.

The receipt itself, reference included, is on the access report of everybody
the row reaches: the person a charge is on, and whoever lived in the apartment
across a notice or a charge on the apartment. On those shared rows the report
withholds the reference where anybody else who lived there across the row has
protected personal data or a restriction of processing, because a reference
built from names can name them. The plugin, the route and the day stay.

`finances:recordDelivery` reads nothing on its own and does not raise a route's
floor. A plugin that delivers also needs `finances:read` to know what to
deliver.

#### Events

Under `finances:read`, a plugin subscribes once, from `onModuleInit`:

```ts
await host.finances.events.subscribe(async (event) => {
  if (event.type === "feeNotification.issued") {
    const run = await host.finances.notification(event.notificationId);
    // ...hold it for approval, then deliver.
  }
});
```

| `type`                   | `version` | Carries          | When                                     |
| ------------------------ | --------- | ---------------- | ---------------------------------------- |
| `feeNotification.issued` | 1         | `notificationId` | The board issued a period's notices.     |
| `memberCharge.recorded`  | 1         | `chargeId`       | The board recorded a charge.             |
| `memberCharge.corrected` | 1         | `chargeId`       | The board corrected one.                 |
| `memberCharge.removed`   | 1         | `chargeId`       | The board removed one, receipts and all. |

Every event also carries an `eventId`, the same on each redelivery, and
`occurredAt`, an ISO 8601 instant. It carries identifiers and nothing else, so
it needs no masking: the plugin reads the row through the reads above, on their
rules.

- **In the act's own transaction.** The event is enqueued by the transaction
  that writes the run or the charge, so an act that rolled back never produces
  one and an act that committed always does.
- **At least once, in no particular order.** Each plugin has its own queue. A
  handler that throws is retried with a growing wait, and the event is dropped
  once the retries are spent. Make the handler idempotent on `eventId`.
- **To a plugin that is serving and subscribed when the act commits.** A plugin
  switched off, or not yet subscribed, misses the event; on start it reads what
  it missed with `notifications()` and `charges()`. An event already queued when
  the board switches a plugin off is not handed to it.
- **Versioned per type.** A version moves when a field is removed or changes
  meaning, and a field added keeps it. `host.finances.events.supported` maps
  each type this instance delivers to its version, so a plugin built against a
  newer SDK can tell an event this instance never sends from one that has not
  happened. Ignore a `type` you do not know.

Nothing in core delivers a notice, so there is nothing for a plugin to hold back
in core: the event reaches the plugin before anything has left the association,
and an approval step is the plugin deciding what it delivers. Issuing is not
something a plugin can refuse. A run and its notices are the association's
accounting records (bokföringslagen 1 kap. 2 § 9) from the moment they are
written, and 7 kap. 1 § forbids altering what is preserved.

### Proposing an import

Not yet in a release. This section states the contract
[ADR 0043](adr/0043-a-plugin-proposes-an-import-and-the-board-applies-it.md)
decided, so a plugin can be designed against it.

**Minimum host release.** An older instance does not run such a plugin at all.
Its manifest parser rejects `addressBook:proposeImport` and the personal data
categories `personalIdentityNumber` and `protected` as invalid values, before it
loads the plugin, and `apiVersion` stays `1`, so there is nothing to
feature-detect. Treat the first core release that lists
`addressBook:proposeImport` in the table above as an install prerequisite and
name it in your catalog entry and README. A `host.imports !== undefined` check
is a defensive guard only; it is not compatibility with older hosts.

A plugin that brings in the association's member list from elsewhere - a file
mailed to an address, an export fetched from the economic manager's system -
hands the list to the core with `host.imports.propose`, under the
`addressBook:proposeImport` permission. The core holds it as an **import
proposal**: an import session on the core's own import screen, marked as
proposed by your plugin, which a board member previews, decides and applies, or
rejects. Your plugin never applies anything.

```ts
if (host.imports !== undefined) {
  try {
    const receipt = await host.imports.propose({
      fileName: "medlemmar.xlsx",
      content: bytes,
      sender: "styrelsen@example.se", // as the source reports it; optional
    });
    // receipt.proposalId, receipt.rowCount, receipt.expiresAt
  } catch (error) {
    // ImportProposalRefusedError carries a reason code, such as
    // "file-too-large" or "file-unchanged". Nothing was stored.
  } finally {
    // Drop your copy of the file here, whatever the outcome.
  }
}
```

**You hand over the file**, CSV or XLSX, and the core parses it exactly as it
parses an upload, with the same limits and the same reason codes. A source that
gives you JSON is written out as CSV first. A file whose bytes equal the last
one the board applied from your plugin, or the one still pending, is refused
with `file-unchanged`. `sender` is optional free text of at most 320
characters (longer is refused with `sender-too-long`); leave it out for a source
that has none.

**One pending proposal per plugin.** A new one replaces the one before, which
becomes `superseded`. A proposal no one decides expires after 14 days. The core
fills in the column mapping the board saved for your plugin when the file's
column titles are the same; when they are not, the board maps them again.

**Where the sender is kept.** The core keeps it, not you: encrypted on the
proposal's record, shown to the board as "Sent from ..., as reported by" your
plugin, and deleted with the record 90 days after the proposal is decided. It is
not in the audit log and is not returned to you. Use it to reply with
`mail:send` while you handle the delivery, and keep it no longer.

**What you get back** is the receipt (the proposal's id, the number of data rows
the core read, the expiry), a refusal's reason code, and, through
`host.imports.status(proposalId)`, the state of your own proposals: `pending`,
`applying`, `applied`, `failed`, `rejected`, `superseded`, `expired`,
`withdrawn`, or `unknown` for an id that is not yours or no longer kept. Never
what a row would do, which person it matched, how many rows matched or would
change, or who decided: each of those is a read of the register, and this
permission grants none. `host.imports.withdraw(proposalId)` takes back a
pending proposal.

**What you must declare.** The file can hold every name, contact detail and
personal identity number in the cooperative, and rows about persons with
protected personal data. A manifest declaring `addressBook:proposeImport` must
therefore declare the personal data categories `name`, `apartment`,
`residency`, `email`, `phone`, `personalIdentityNumber` and `protected`, so the
board sees what the plugin carries before it consents.

**What you must not keep.** The catalog review checks all three:

- never pass the file, or any part of it, to `host.jobs`: a job's data is
  stored in the database until the job has run;
- never write it to the log, to the settings or to an error you throw;
- drop your copy once `propose` has resolved or been refused.

A relay pushes a file to your plugin's endpoint and keeps it until you
acknowledge it, which you do only after `propose` has answered. The core has no
such route yet: every plugin route needs a signed-in person, and a device route
reads only. The authenticated inbound route for a machine is a follow-up gap in
the core, and until it exists a plugin cannot receive a file from a relay this
way. Scheduled pull is not the decided delivery.

### Routes

Controllers are mounted under `/api/plugin/<id>/` whatever path they declare,
inside the application's authorization guard. Each is raised to the capability
floor implied by the plugin's own permissions, so a plugin that reads the
register cannot expose that reading to a caller the core would not let read
it. The floor is every capability those permissions imply: `addressBook:read`
for either address-book permission, and both `fees:manage` and
`memberCharges:manage` for `finances:read`, because it reads both halves of
the books. A plugin with none of these is held to `self:manage`, which every
account has. The same floor holds for the plugin's actions. A controller may require **more** with `@RequireCapability`; it cannot
require less, and `@Public()` on a plugin route has no effect.

`RequireCapability` is exported from `@openbrf/plugin-sdk`, on a controller or
on a single route. Several names are combined with AND, and each must be one of
`PLUGIN_ROUTE_CAPABILITIES`, the capabilities the instance has (`PluginRouteCapability`
is the type). It writes the names under the metadata key
`openbrf:required-capabilities`, exported as `REQUIRED_CAPABILITIES_KEY`; use the
decorator rather than setting the key yourself. Like the SDK's other values it is
inlined by the bundler, and it needs no import beyond the `@nestjs/common` your
controller already has.

```ts
import { Controller, Post } from "@nestjs/common";
import { RequireCapability } from "@openbrf/plugin-sdk";

@Controller("themes")
export class ThemesController {
  @Post("install")
  @RequireCapability("association:manage")
  install(): Promise<void> {
    // ...
  }
}
```

A handler that throws is answered as a bad gateway and logged with the
plugin's id. A handler that throws an `HttpException` of its own is answered
with what it asked for.

### What a plugin's module may not do

A NestJS module can declare things whose effect is application-wide. A module
doing any of the following is refused at load and reported on the admin
screen, the same way a malformed manifest is:

- providing `APP_GUARD`, `APP_INTERCEPTOR`, `APP_FILTER` or `APP_PIPE`, which
  would act on the application's own routes;
- registering middleware through `NestModule.configure`, for the same reason.
  NestJS asks the module's instance, so a `configure` the instance is given
  when it is built - in a constructor or a field - is refused as well, once
  the application is built;
- declaring itself `@Global()`, which would export its providers into every
  module in the application;
- declaring a controller or route path that steps outside the plugin's prefix;
- giving any part of the module through a getter or a proxy, or a list other
  than as a plain array: its providers, controllers and imports, and a
  controller's or route's paths and required capabilities. NestJS reads each
  of these again after the load has checked it, and NestJS's decorators write
  them in the shapes that are allowed.
  The name of a module or controller class is not among them: the seal does
  not run a getter for it, but NestJS reads it again when it builds the module.
- changing what the load has read once it has read it, from a forward
  reference's thunk or from a timer or promise the plugin's factory leaves
  behind. Each list and declaration the load reads is frozen as it is read,
  and a dynamic module's lists are fixed to it, so writing into one throws.
  The one exception is a dynamic module's `imports`: the load writes the
  module a forward reference resolved to in the reference's place, so it can
  only close that list to new entries while it reads. It freezes the list once
  written, and refuses the module if the list no longer holds what was read
  (the same entries, in the same places, and the same length), whether a thunk
  changed an entry or the length.
  What a class holds - its metadata and its fields - is read again once the
  load is done, before the application is built and once it is built, and
  compared with what the load first read of it.
- giving a dynamic module a field other than `module`, `global`, `imports`,
  `controllers`, `providers` and `exports`, or any field behind a getter;
- being built into something other than what the load read, however briefly
  the plugin's code changed it while NestJS built it: importing a module the
  load did not read, being global, holding a provider or a controller the load
  did not read, or having an instance given a core service a plugin may not
  hold. What NestJS built is checked once it is built. A module of one of the
  application's own classes is the application's only where the application
  declares that module; a dynamic module of its class the plugin brings in is
  a module of the plugin's, and is checked as one;
- having a controller built into something other than a plain instance of its
  own class. NestJS serves the instance it built, so each controller is
  checked once the application is built, and refused when it is built for
  each request or each injection (request-scoped, transient, or depending on
  something request-scoped), when its constructor returns another object, when
  its prototype names another class as its constructor, or when the instance
  holds a property of its own under a name its class's prototype chain holds,
  such as a class field named after one of its methods.
  A controller instance that passes is then given its own `constructor` and
  its own copy of each route method the load read, each read-only, so each
  route the load checked keeps the method and the class it was checked with,
  whatever the plugin's code does afterwards. The instance then takes no new
  property and keeps its prototype, so give every field the controller uses a
  value in its constructor or its declaration. Its class's own prototype is
  frozen, and so is the prototype of each base class further down the chain
  that the plugin's server entry defines, up to the first one it does not: a
  built-in's, Node's, a shared package's or one from another of the plugin's
  files is left as it is, with the rest of the chain. Assigning to a route
  method's name on the instance, or to a property it does not hold, throws
  from then on. So does assigning to a name a frozen prototype holds, on any
  object built from it: a service extending the same base class that runs
  `this.format = this.format.bind(this)` throws, so give `format` a value in
  a class field instead. A controller whose instance cannot take all of this,
  such as one its constructor made non-extensible, is refused. A request
  reaches a plugin's controller only through a route the load checked, on a
  path and with a request method the load read for it, and is authorized by
  what the load read of that route: any other request NestJS routes to the
  controller answers as though the plugin were not installed.

Guards, interceptors, filters and pipes scoped to the plugin's own
controllers - `@UseGuards` and the rest - are allowed. They narrow what
reaches a handler and cannot widen it. What they are constructed with is held
to the same rule as a provider's (`forbidden-injection` below).

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

### Where a view is found

A view is the plugin's own screen at `/app/plugin/<id>`, under its title. On
its own it is reachable by that address and nothing else. `view.section` names
the section of the application's navigation its entry stands in:

| Section       | Holds                                                                                |
| ------------- | ------------------------------------------------------------------------------------ |
| `association` | The association and its life: the overview, news, the calendar, the general meeting. |
| `building`    | The building and the apartments in it: issues, bookings, keys, subletting.           |
| `board`       | The board's own desk. Only destinations no resident is offered.                      |
| `settings`    | How the instance is configured, and each account's own settings.                     |

The entry stands after the core's own destinations in that section, under the
view's title, and never in the phone's bottom bar. A plugin cannot add a section
of its own. The field is optional: a manifest without it is valid, and its view
stays reachable by its address alone, as every view was before the field
existed.

Naming a section asks for an entry and does not grant one. The host offers the
entry only to an account that holds what the plugin's routes require - the
floor its permissions imply, so a plugin reading the register is offered to the
board and the administrator and not to a resident - and in `board` only to the
board and the administrator, whatever the routes would admit. An account that
is not offered the entry can still open the view by its address, and the
plugin's routes still refuse whoever lacks their floor: the navigation is not
where access is decided.

`GET /api/plugin-views` answers this per account: every view, each with the
`section` the asking account is offered it in, or `null`.

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

### Settings are not for credentials

Do not declare a setting for a password, an API key, an OAuth token or anything
else that opens an account somewhere else. Today a setting is:

- stored as plain JSON in the instance's database, where the instance's own
  credentials - the SMTP password, the SMS provider's token, the board
  mailbox's password - are encrypted field by field, so a database dump or a
  backup carries it readable;
- returned whole to the admin screen and through the settings API, and drawn
  back into the form, so anybody who may open the plugin's settings reads it;
- written only by an administrator. A plugin cannot write its own, so it has
  nowhere to keep an access token it refreshed, and some accounting systems
  replace the refresh token on every use.

A setting that holds a credential, encrypted at rest, never sent back to the
browser and writable by the plugin, is open work in the core and is not in this
contract version. Until it is, a plugin that needs a per-instance credential
does without one, or asks the core for that store rather than working around
it.

## Website blocks

A page on the association's website is a list of blocks, never markup ([ADR
0006](adr/0006-the-page-block-model.md)). A plugin adds block types to that
list: the manifest declares each one, the server bundle registers the function
that renders it, and the host does everything else - offers it in the page
editor, holds every save to its settings, calls the render function while it
renders a page, and decides what of the answer reaches the visitor.

### Declaring a block

```jsonc
{
  "openbrf": {
    "permissions": ["site:blocks"],
    "blocks": [
      {
        "name": "schedule",
        "labelKey": "blocks.schedule.label",
        "icon": "calendar",
        "category": "association",
        "settingsSchema": {
          "fields": [
            {
              "key": "days",
              "labelKey": "blocks.schedule.days",
              "type": "number",
              "integer": true,
              "min": 1,
              "max": 14,
              "default": 7,
            },
          ],
        },
      },
    ],
  },
}
```

| Field            | Required | Meaning                                                                                                                                             |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | yes      | A lowerCamelCase word of at most 32 characters, unique within the plugin. The page stores the block under the type id `<plugin id>/<name>`.         |
| `labelKey`       | yes      | The block's name in the editor, as an i18n key in the plugin's namespace. The add button reads "Add" and this name.                                 |
| `icon`           | no       | One of `plugin` (the default), `paragraph`, `heading`, `image`, `form`, `news`, `calendar`, `documents`, `people`, `facts`, `contact`, `questions`. |
| `category`       | no       | Where the editor files it: `text`, `media` or `association` (the default).                                                                          |
| `settingsSchema` | no       | The settings the board fills in on each block, declared as [Settings](#settings) are. The editor draws the form.                                    |

Each block on a page carries its own values, stored as `{ type, settings }`.
A save is held to the declaration while the plugin is serving: a value outside
it is refused with the path of the setting, and a setting the declaration no
longer has is dropped. A block the board has just added whose required
settings are unanswered is not sent, as a picture with no file is not. One the
page already holds is never left out of a save, because the save carries the
whole page and leaving it out would delete it: when a new version asks for a
setting the block does not hold, or no longer offers the option it holds, the
editor names the block and refuses to save until the board answers it or
removes the block. A block is held to the size an
unregistered block may have as well (10 000 characters of JSON), because that
is how it is read while its plugin is switched off.

Every string in a block's settings is scanned for a personal identity number
before the page is published, as words and as an address both, because nothing
outside the plugin knows which of them it prints or links to.

### Rendering it

```ts
export const createPlugin: PluginModuleFactory = (host) => {
  host.blocks.register({
    name: "schedule",
    render: async ({ settings, t, signal }) => {
      const days = await bookedDays(Number(settings.days), signal);
      return [
        { tag: "h2", children: [t("blocks.schedule.heading")] },
        {
          tag: "ul",
          children: days.map((day) => ({ tag: "li", children: [day] })),
        },
      ];
    },
  });
  // ...
};
```

Call `host.blocks.register` from the module factory: the host reads the
registrations once, while the application starts. A name the manifest does not
declare, or one registered twice, stops the plugin serving and is reported as
`block-refused`. A declared block with no render function is not offered in
the editor, and a page that holds one shows nothing in its place.

The render function is told the block's `type`, its `settings` - validated
against the declaration, with the declared defaults applied - the `locale` the
page is rendered in, a translation function `t` in the plugin's own namespace,
and an abort `signal`. The signal is a real `AbortSignal`, and the SDK types
it as the one the plugin's own program knows, from the DOM library or Node's
types, so it goes into `fetch` without a cast. Nothing about the reader: one
stored page is rendered for a visitor with no account and for a member alike.

`host.blocks` was added after this contract version shipped, so a plugin built
against a newer host than the one it runs on must feature-detect it, as it
does `host.actions`.

### What reaches the page

The render function answers with a tree of elements, not with HTML:

```ts
type PluginBlockNode =
  | string
  | {
      tag: string;
      attributes?: Record<string, string>;
      children?: PluginBlockNode[];
    };
```

The host copies the answer out through JSON, keeps what is on two short lists,
and prints the rest through the same renderer as the board's own blocks. Text
is escaped, so `"<b>"` reads as the three characters.

| Kept                   | Elements                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Text and its structure | `p`, `h2`, `h3`, `h4`, `ul`, `ol`, `li`, `dl`, `dt`, `dd`, `strong`, `em`, `small`, `code`, `blockquote`, `br`, `span`, `div`, `section`, `time` |
| Tables                 | `table`, `caption`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`                                                                                  |
| Links                  | `a`                                                                                                                                              |

| Attribute  | On     | Kept when                                                                                                         |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `href`     | `a`    | It is `http`, `https`, `mailto` or a path on this instance. A link off the instance is given noopener noreferrer. |
| `dateTime` | `time` | It is a machine-readable date or time.                                                                            |
| `scope`    | `th`   | It is `row`, `col`, `rowgroup` or `colgroup`.                                                                     |

An element not on the list is left out with everything inside it: a script, a
stylesheet, a picture, a frame, a form. Every other attribute is left out - an
event handler, a `style`, a `class`, an `id` - and so is an address any other
scheme names; the link keeps its text. A plugin's block therefore loads nothing
from another host and runs nothing, and the website's content security policy
would refuse both if it tried. The host wraps each block in one
`<div class="site-plugin-block">`, the same for every plugin, which is what a
theme styles; nothing on the page names the plugin.

### When a block fails

A plugin's fault hides its own block and never the page. The page is rendered
without the block, and the failure is logged with the plugin's id and the
block's type, when the render function:

- throws or rejects;
- has not answered within 2000 ms (`PLUGIN_BLOCK_RENDER_TIMEOUT_MS`). Every block
  on a page renders at the same time, so this is also about the longest a
  plugin can add to a page's answer. The `signal` is aborted then; the host
  cannot stop the plugin's code, so pass it on to whatever the render waits for;
- answers with something that cannot be copied through JSON, or with more than
  64 000 characters of it, or nested more than 32 levels deep;
- renders something shaped like a personal identity number, in its text, in
  a link or in any other attribute it keeps, such as a `time` element's
  `dateTime`. The publication guardrail refuses a page the board wrote one on, and
  a plugin's block is published on the same page.

The log says which of these it was and never what the block rendered. A
block whose stored settings its declaration now refuses - an option a new
version removed - is not rendered either; the editor shows it with its form,
says what is missing, and does not save the page until the board sets it
again or removes it.

### When the plugin is switched off or removed

The block stays on every page that holds it, exactly as stored. The website
shows nothing in its place, the editor shows it as a plugin's block it cannot
set up - with the controls to move and remove it - and a save carries it back
untouched. Switching the plugin on again brings it back as it was. The page
actions show such a block and do not accept one, a serving plugin's included:
their published input is fixed when the instance starts, and a plugin's
settings are not part of it.

## A plugin's own records

A plugin keeps what it has of its own to remember in `host.records`: JSON values
under a collection and a key, belonging to the plugin and to nothing else
([ADR 0033](adr/0033-a-plugin-s-own-records.md)). It is for what does not fit a
settings form, such as a list of screens, each with its own layout, rotation and
entrance. It needs no permission.

```ts
type Screen = { name: string; addressId: string; rotationSeconds: number };

const current = await host.records.get<Screen>("screens", screenId);
await host.records.put<Screen>(
  "screens",
  screenId,
  { name: "Entrén", addressId, rotationSeconds: 10 },
  // Only over the revision just read, or only as a new record.
  { expectedRevision: current?.revision ?? null },
);

// Every screen, 200 at a time.
let after: string | undefined;
for (;;) {
  const page = await host.records.list<Screen>("screens", { after });
  // ...
  if (page.length < 200) break;
  after = page.at(-1)?.key;
}
```

Declare a value's shape with a type alias, as `Screen` is, rather than an
interface: TypeScript holds an interface to `JsonValue` only with an index
signature of its own.

| Method                                               | Answers                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `get(collection, key)`                               | The record, or `null`.                                                                               |
| `list(collection, { after?, limit? })`               | The collection in key order, from after `after`. At most 200 records per call, which is the default. |
| `put(collection, key, value, { expectedRevision? })` | The record as written.                                                                               |
| `delete(collection, key, { expectedRevision? })`     | `true` when there was a record to delete, `false` when there was none.                               |

A record carries its `collection`, `key`, `value`, `revision` and `updatedAt`.
`revision` is 1 when the record is first written and one more on every write
after that, for the reason ADR 0008 gives for a page's: two writes inside one
millisecond carry the same time.

- **Compare-and-set.** With `expectedRevision: null`, a `put` writes only where
  there is no record yet. With a number, a `put` or `delete` writes only over
  that revision. Otherwise it throws `PluginRecordConflictError`, whose
  `actualRevision` is the revision the store holds, or `null`. The one
  exception is a `delete` that finds no record: it answers `false` whatever
  `expectedRevision` it was given. Without `expectedRevision` the last write
  wins.
- **Names.** A collection is lowercase letters, digits and single hyphens, at
  most 32 characters. A key is 1 to 128 letters, digits, `.`, `_`, `:` or `-`.
  Key order is the order of those characters, so `"002"` comes before `"010"`
  and `"B"` before `"a"`. A name outside either pattern throws a `RangeError`,
  and so does a `limit` outside 1 to 200 or a revision that is not a positive
  integer.
- **Values.** Any JSON: an object, an array, a string, a number, a boolean or
  `null`, nested at most 64 levels deep. A value JSON cannot carry exactly
  throws a `TypeError` instead of being changed on the way in: `undefined`, a
  function, `NaN` or `Infinity`, a `Date`, a `Map` or any other class instance,
  a hole in an array, a NUL character, a lone surrogate or a property named
  `__proto__`, which the store does not keep. A `put` copies the value when it
  is called, reading each property once, so what the store keeps is what the
  value held then: changing the object afterwards, while the write is still
  under way, changes nothing. An object's properties come back in an order of
  the store's own.
- **Limits.** A value is at most 64 KiB as JSON in UTF-8. A plugin holds at
  most 10 000 records and 16 MiB in all, across its collections. A write past
  any of them throws `PluginRecordLimitError`, whose `limit` is `valueBytes`,
  `records` or `totalBytes`. A write that does not grow what the plugin holds,
  such as an overwrite with a smaller value, is never refused. The figures are
  exported as `PLUGIN_RECORD_LIMITS`.

The SDK is a type-only import, so tell the errors apart by `name`
(`error.name === "PluginRecordConflictError"`), not with `instanceof`.

### Configuration, never people

**A plugin's records hold configuration and never anything about a person.** A
screen's entrance is an address id from `host.addressBook`, and a screen's name
is the board's own text. A person's name, an email address, an apartment someone
holds or anything else copied out of the register does not belong here. The data
subject access report, purging, erasure and restriction all read the core's own
tables, and a plugin's JSON is opaque to every one of them, so personal data
kept here would be data the association holds and cannot report, purge or
restrict.

The host cannot tell a name from a label, so the rule is declared, and the
catalog's review reads a server bundle's writes to `host.records` against it.
What the host does refuse is a personal identity number, as it refuses one on a
page: every string in the value, every property name, every number, the key and
the collection are scanned, and a write carrying one throws
`PluginRecordIdentityNumberError`. A plugin that has to remember something about
a person uses `host.personRecords` instead (see
[Records about a person](#records-about-a-person)).

A secret a plugin keeps here, such as an API key for a service of its own, is
readable by anyone who can read the database, as its settings are. The host does
not encrypt records.

### Switching off, removing, backups

Switching a plugin off keeps its records, and `host.records` throws
`PluginHostUnavailableError` until the plugin is switched on again, as every
host service does. Removing a plugin deletes its records with it, and the remove
screen says so before the board confirms. A reinstall starts with none. The
records are in the instance's database, so its backup carries them and a restore
brings them back.

`host.records` was added after this contract version shipped, so a plugin built
against a newer host than the one it runs on must feature-detect it, as it does
`host.actions`.

## Licences

A paid plugin is an ordinary plugin that reads an **instance licence** (ADR
0042): a small file its issuer signs for one instance, entered once with
`openbrf licence add <file>` or through `POST /api/licences` under
`association:manage`, which the licence screen in the web interface is built
on. The host verifies it offline, against the keys the plugin's manifest declares
and the instance's own id and key, on the association's calendar day. The
plugin never sees the file. It reads the finding through `host.entitlements`
and decides for itself what it withholds without an active entitlement: the
host loads and serves it either way, and never switches it off because of a
licence.

### Declaring it

```jsonc
"licence": {
  "entitlement": "themes",
  "issuer": { "name": "Example AB", "url": "https://example.org/licence" },
  "keys": { "example-2026-1": "<base64 of the 32-byte Ed25519 public key>" },
  "audiences": ["https://themes.example.org"],
},
"released": "2026-12-01",
```

- `entitlement` is the one entitlement the plugin reads, written as a plugin id
  is. A licence may carry several; the host reports this one only.
- `issuer` is who the licence screen and the audit log name as the issuer.
  Nothing in a licence file names one. Its `url` is an `https` address that
  answers the issuer's document in the `openbrf-licence-issuer/1` format: its
  `name`, its keys and the repositories its plugins are released from. The
  catalog lists a plugin only when its `url` is written as
  [A licensed plugin](#a-licensed-plugin) says and that document gives the
  same `name` as the licence does, lists the repository the plugin is released
  from and holds every key in `keys` (see also
  [ADR 0042](adr/0042-a-signed-licence-per-instance-verified-offline.md#the-issuers-document-at-issuerurl),
  which is still Proposed). The index schema does not read a plugin's `licence`
  and `released` on an entry yet, so no licensed plugin can be listed until it
  does. An instance never reads the document.
- `keys` holds one or two of the issuer's public keys by key id: a new key is
  declared in a release before any licence is signed with it. A key id is 1 to
  64 lowercase letters, digits and hyphens. Two plugins may declare one key id
  with different keys, and each reads only the licences its own key verified,
  judged by the key's fingerprint. The catalog lists only one of them, though:
  it refuses a plugin that declares a key id another plugin in the index
  declares with a different key (see [A licensed plugin](#a-licensed-plugin)).
- `audiences` are the issuer's services the plugin may present the licence to,
  each an `https` origin in its canonical form (`https://host` or
  `https://host:port`, lower case, no path and no trailing slash), at most 256
  characters. A plugin that uses no service of its issuer's declares none.
- `released` is written by the release workflow. A plugin that declares a
  `licence` without it is refused as manifest-invalid.

The keys belong to the plugin and not to the core, so anyone who sells a plugin
can issue licences for it in the same format.

### Reading it

`host.entitlements` is present only on a plugin whose manifest declares a
`licence`, and was added after this contract version shipped, so feature-detect
it as you would `host.actions`:

```ts
const state = (await host.entitlements?.get()) ?? { status: "absent" };
if (state.status !== "active") {
  // Dormant: do only what is free, and say why on the plugin's own screen.
}
```

`get()` judges the entitlement at every call, so a licence entered, one that
ends and the next one taking over reach a running plugin without a restart. Its
answer is one of:

| `status`              | Means                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| `active`              | A licence covers today and this release. Carries its id and both dates.         |
| `absent`              | No licence the plugin's keys verified names the entitlement.                    |
| `expired`             | Today is after its `validUntil`.                                                |
| `version-not-covered` | This release was published after its `updatesUntil`. An earlier one is covered. |
| `wrong-instance`      | It was issued to another instance, by id or by key.                             |
| `tampered`            | It verified when it was entered and no longer does.                             |
| `not-yet-valid`       | It was issued after today: a wrong clock on one side or the other.              |

Dates are inclusive and read on the association's calendar day in
`Europe/Stockholm`. With several licences active, one order selects among them
(the latest `validUntil`, then the latest `updatesUntil`, an absent date
counting as the latest, then the latest `issuedOn`, then the lowest licence
id), and `present()` presents the same one `get()` describes. With none active,
the finding is that of the licence entered most recently.

`present(audience)` returns the selected licence with a fresh signature by the
instance key, as the text to send the issuer's service, or null without an
active licence. It signs without a network call; sending it is the plugin's.
It throws a `RangeError` for an audience the manifest does not declare. A
presentation is good once and for five minutes at its audience, so make one
per request.

In a plugin's own tests, `createTestEntitlements({ state, audiences })` from
`@openbrf/plugin-sdk` stands in for `host.entitlements` and keeps both of the
host's rules about presenting.

### The two formats

A licence file is compact or pretty JSON of at most 16 KiB:

```jsonc
{
  "format": "openbrf-licence/1",
  "keyId": "example-2026-1",
  "payload": "<base64url of the payload's UTF-8 JSON>",
  "signature": "<base64url Ed25519 signature>",
}
```

The signature covers the bytes `openbrf-licence/1\n` followed by the decoded
payload. The payload is strict: it has `licenceId`, `issuedOn`, `instanceId`,
`instanceKey`, `association` (`name` and an optional `organizationNumber`) and
`entitlements`, each entitlement with an optional `validUntil` and
`updatesUntil`, and a field version 1 does not define is refused. The host also
refuses base64url that is padded or not in its one spelling, a signature that
is not 64 bytes, bytes that are not UTF-8, an object that repeats a key, a date
that is not a real day, and a UUID that is not lower case, so that no other
verifier can read one signed file another way.

A presentation is JSON of at most 24 KiB:

```jsonc
{
  "format": "openbrf-licence-presentation/1",
  "licence": "<base64url of the licence file's bytes, as entered>",
  "claims": "<base64url of the claims' UTF-8 JSON>",
  "signature": "<base64url Ed25519 signature by the instance key>",
}
```

The claims are `audience`, `licenceId`, `entitlement`, `issuedAt` (UTC to the
second) and a 16-byte `nonce`, signed after the prefix
`openbrf-licence-presentation/1\n`. A service accepts one when the licence
verifies under its own table of the issuer's keys and matches the issuer's
ledger, the claims' licence id is the licence's, the signature verifies under
the `instanceKey` the licence names, the audience is its own origin, the
entitlement is the one it serves and is granted today, and `issuedAt` is within
five minutes with a nonce it has not seen. ADR 0042 sets out the rest.

### What the licence never stops

A missing, lapsed, copied or forged licence makes one module dormant and
nothing else. The core never reads a licence for a feature of its own, and the
board can always switch a licensed plugin off, remove it, disarm its actions
and export the association's data.

## Records about a person

> Decided in [ADR 0047](adr/0047-a-plugin-s-records-about-a-person.md) and not
> yet in a released instance. Until it is, `host.personRecords` is `undefined`,
> and the feature check below is what a plugin sees.

A plugin that has to remember something about a person - who offered a parking
space for which days, who claimed it - keeps it in `host.personRecords`. The
host keeps those records as it keeps the core's own bookings: it erases each
one on the day the plugin set, erases a person's records when the board grants
their erasure request, keeps them through a legal hold or a restriction, and
prints them on the person's data subject access report. None of that runs your
code, so it works the same while your plugin is switched off, broken or removed.

The keyed store of [ADR 0033](adr/0033-a-plugin-s-own-records.md),
`host.records` (see [A plugin's own records](#a-plugins-own-records)), is for
configuration and never for people. The two never share a collection.

### Declaring a collection

Every collection you keep records about a person in is declared in the
manifest. The board reads the declaration on the consent screen before anything
is downloaded.

```jsonc
{
  "openbrf": {
    "personalData": ["apartment", "residency"],
    "processing": {
      // Required with personRecords; see ADR 0035.
    },
    "personRecords": [
      {
        "collection": "claims",
        "titleKey": "records.claims.title",
        "personalData": ["apartment"],
        "keepAtMostDays": 730,
        "fields": [
          {
            "key": "space",
            "labelKey": "records.claims.space",
            "provided": true,
          },
          {
            "key": "from",
            "labelKey": "records.claims.from",
            "provided": true,
          },
          { "key": "to", "labelKey": "records.claims.to", "provided": true },
          { "key": "status", "labelKey": "records.claims.status" },
        ],
      },
    ],
  },
}
```

| Field            | Required | Meaning                                                                                                                           |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `collection`     | yes      | Lowercase letters, digits and single hyphens, at most 32 characters. Not also used with `host.records`.                           |
| `titleKey`       | yes      | The collection's heading on the access report, a text key in your namespace.                                                      |
| `personalData`   | yes      | The categories its records hold, each among the manifest's own `personalData`.                                                    |
| `keepAtMostDays` | yes      | The longest a record may be kept, counted from the day it is written. At most 1 830.                                              |
| `fields`         | no       | The top-level keys of a value the access report labels, each with a `labelKey`. A key not listed here is still printed as stored. |

Mark a field `"provided": true` when the person gave it to you, as the claimer
gives the space and the days. The portability export carries only those fields
(see "What the host does with them"). A field you set yourself, such as a
status, gets no mark: it is printed on the access report and stays out of the
export.

At most eight collections. A manifest with `personRecords` also declares
`processing` (ADR 0035), because every record has to belong to a row in the
association's record of processing activities. A republished version that adds
a collection, widens a collection's categories or lengthens its
`keepAtMostDays` is refused at load as `personal-data-widened`, as a wider
`personalData` is.

### Writing and reading

```ts
// `caller` is the person making the request; see "Who is calling" below.
const claim = await host.personRecords.put(
  "claims",
  offerId,
  {
    subject: caller.resident.personId,
    eraseOn: "2027-11-08", // a year after the last day
    value: { space: "P12", from: "2026-11-02", to: "2026-11-08" },
  },
  { expectedRevision: null },
);
```

Every record is about **one person**, its `subject`, and carries the day it is
erased, its `eraseOn`, as a calendar day in the association's time zone.

- With `expectedRevision: null` the write succeeds only where no record holds
  the key. That is how a first claim wins: the second is refused with
  `PluginRecordConflictError`. With a number, the write succeeds only over that
  revision.
- `eraseOn` may be no later than `keepAtMostDays` after the day of the write,
  and a later day is refused with `PluginRecordRetentionError`. Rewriting a
  record may move it, within the same bound.
- A new record's subject must be somebody `host.addressBook.residents()` would
  list to your plugin at that moment. Anybody else is refused with
  `PluginRecordSubjectError`, and the error does not say why. A record that
  already names a person can be rewritten with the same subject after that
  person has moved out.
- `list(collection, { subject })` returns one person's records, and without a
  subject it pages through the whole collection in key order, 200 at a time.
- The value is a JSON object of at most 64 KiB. The records of both stores
  count towards one limit per plugin, 10 000 records and 16 MiB, and a write
  past it is refused with `PluginRecordLimitError`.

Relate two people with two records rather than one. The offer is the holder's
record and the claim the claimer's, and the claim's key or value carries the
offer's key. Erasure, restriction and the access report act on whole records,
so one record about two people would go with the first person's erasure.

**Refer to the register and do not copy it.** Store the person id and read a
name or an address again when you need one. Never store an email address or a
telephone number in a value: the core encrypts both, and a record's value is
not encrypted. A personal identity number is refused on every write.

### What the host does with them

- **Erasure on the day.** Every night, after the core's own purges, the host
  deletes every record whose `eraseOn` has passed.
- **Erasure on request.** When the board grants a person's erasure request, the
  same run deletes every record about them, and the request is not closed while
  any is left.
- **Legal hold and restriction.** Neither run touches the records of a person
  under a legal hold or a restriction. If your plugin deletes or overwrites such
  a record, the write succeeds, and the host sets the old version aside: it is
  gone from your reads and stays on the person's report until the hold has ended
  and its erase date has passed. To your plugin it looks like an ordinary write.
  An overwrite gives the new value the next revision, and a delete frees the
  key, so a create-only write onto it succeeds. Versions set aside count towards
  your limits until they go.
- **Records you cannot see.** A record whose subject has protected personal
  data, is under a restriction, or has objected to your plugin's processing is
  absent from `get` and `list`. Its key stays taken, so a create-only write onto
  it is refused as a conflict. A moved-out person's records stay visible until
  their erase date.
- **The access report.** Every record about the person, from every plugin, is
  printed in full under the collection's title: its key, the declared fields
  under their labels, then every other key as stored, with the erase date and
  whether it is set aside.
- **The portability export.** It carries a record only when the basis the
  manifest's `processing` declares is `consent` or `contract`, only while the
  record is not set aside, and then only its `provided` fields, with your
  plugin's id and name, the collection's title and the key. Everything else
  stays on the access report, as the board's own notes do for the core's
  records. A collection that marks no field `provided` is not exported at all.
- **Removing the plugin** deletes its records, except those of a person under a
  legal hold or a restriction, which are set aside, and the versions already set
  aside. These outlive the plugin until no hold covers them and their erase date
  has passed. Reinstalled under the same id, your plugin does not see them, and
  they count towards its limits until they go. Switching it off deletes nothing.

You learn that a record has gone by not finding it. There is no callback.

### Who is calling

```ts
const caller = await host.addressBook.caller(request);
if (caller.kind === "notListed") {
  // Tell the person the module is not available to them, and to ask the board.
}
```

`caller` takes the request your route received and answers with that person as
`residents()` would list them, or `notListed`. A person who does not live in the
house, a former resident, a person with protected personal data, a person under
a restriction and a person who objected to your processing all read
`notListed`, and you are not told which. It needs `addressBook:read`.

### Naming the person in an audit entry

`host.audit.record` (ADR 0035) takes an optional `subject`, held to the same
rule as a record's. The entry then names that person as its target, and it
reaches their access report. The `detail` still never names a person. The host
records nothing for an ordinary write, so record the acts that matter yourself,
such as a claim made or an offer withdrawn.

### Feature detection

```ts
if (host.personRecords === undefined || host.addressBook.caller === undefined) {
  // This instance cannot keep records about a person. Keep none, and say so.
}
```

`host.audit` takes `subject` from the same release as `host.personRecords`. An
instance older than that ignores `personRecords` in the manifest, so the check
in your code is what stops the plugin. Never fall back to `host.records`: a
record about a person kept there has no erase date and is on nobody's report.

## Installing themes

A plugin that delivers themes - a pack it fetches from a service of its own, for
instance - hands each package to the core with `host.themes.install`, under the
`themes:install` permission ([ADR 0046](adr/0046-paid-themes-delivered-to-a-licensed-instance.md)).
Nothing in it is about a vendor or a licence; any plugin may use it.

```ts
@Post("install")
async install(@Req() request: object, @Body() body: { id: string }) {
  const { bytes, sha512 } = await this.pack.download(body.id);
  return host.themes.install(request, bytes, { sha512 });
  // { id, version, warnings }
}
```

**The core's gate, not yours.** The package's sha512 is checked before
anything is unpacked, in either spelling a catalog entry may use
(`sha512-<base64>` or 128 hex characters). The package is then read and held to
the same install lint as a catalog package, the statutory register's contrast
included, and the files and the row are written together under the same lock
per theme id. A refusal is thrown as an error carrying a `reason` and, for
`lint-failed`, the `findings`; let it propagate from your route and your client
is answered with its status, reason and findings, as the theme screen is. The
reasons are those of the theme screen, and these four of its own:
`checksum-mismatch` and `malformed-digest` (422) for the digest you stated,
`package-too-large` (422) above the 8 MiB a theme package may have, and
`forbidden-capability` (403).

**As the person behind the request.** `install` takes the request your route
received and installs as the person on the other end of it, who must hold
`association:manage`, the capability the theme screen requires. A request a
connected app's token reached is refused, as is any request on the route of a
plugin whose manifest declares an AI package, and a background job has no request,
so a theme is installed only when an administrator asks for it. Raise your
install route to `@RequireCapability("association:manage")` (see "Routes") so the person is
refused before you download anything.

**Only over your own.** A plugin installs over a theme it installed itself,
which is how it updates one, and over nothing else: a theme from the catalog,
one composed on the instance or another plugin's is refused with
`theme-not-from-plugin` (409). The catalog likewise does not install over yours
(`theme-from-plugin`), and the composer does not edit it. `host.themes.list()`
returns the themes your plugin installed, with their versions, so you can offer
an update; no other theme is visible through it.

**It installs and nothing else.** Previewing, activating and removing stay on
the core's theme screen, which names the plugin that installed each theme. A
theme stays installed when your plugin is switched off or removed, still naming
it, and the board removes it there if it wants to.

**Minimum host release.** An older instance does not run such a plugin at all:
its manifest parser rejects `themes:install` as an invalid value before it loads
the plugin, and `apiVersion` stays `1`. Name the first core release that lists
`themes:install` in the table above as an install prerequisite in your catalog
entry and README.

## Distribution and installation

An instance never contacts a package registry. The catalog lists direct
tarball URLs with a sha512, and the install job downloads, verifies, and
installs from the local file.

The installer holds npm to that. npm runs offline, with a cache of its own that
starts empty and none of the host's npm configuration or environment, so it
has nothing to install but the verified archives. A package whose
`dependencies`, `optionalDependencies`, `bundleDependencies` or
`bundledDependencies` is anything but absent, an empty map or an empty list
fails the manifest schema and is not loaded. The installer also checks that
each installed package has the name and version the board consented to, and
fails the install before it replaces the running installation otherwise.

One index lists plugins and themes alike:

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
      "homepage": "https://github.com/example/openbrf-occupancy",
      "artifact": {
        "url": "https://github.com/example/openbrf-occupancy/releases/download/v1.0.0/occupancy-1.0.0.tgz",
        "sha512": "sha512-...",
        "bytes": 89408,
      },
    },
    {
      "type": "theme",
      "id": "example-theme",
      "version": "1.0.0",
      "name": { "sv": "...", "en": "..." },
      "description": { "sv": "...", "en": "..." },
      "contract": "^1.0.0",
      "extends": "porttavlan",
      "homepage": "https://github.com/example/openbrf-example-theme",
      "artifact": {
        "url": "https://github.com/example/openbrf-example-theme/releases/download/v1.0.0/example-theme-1.0.0.tgz",
        "sha512": "sha512-...",
        "bytes": 37806,
      },
    },
  ],
}
```

Every entry carries its `type`, `id` and `version`, a `name` and a
`description` in Swedish and in English written by whoever curates the catalog,
and the `artifact`; `homepage` and `deprecated` are optional. A plugin entry
adds `packageName`, the npm name the tarball unpacks as, which the installer
writes into npm's dependency set; `apiVersion`; and the declaration the consent
screen shows before anything is downloaded: `permissions`, `personalData`,
`actions`, for a connector `oauthProtectedResource`, and for an AI package `ai`.
A theme entry adds the token `contract` range and the theme it `extends`, and
names no package: a
theme is read out of its archive and never installed with npm. The installed
package is authoritative for both kinds, and one that disagrees with its entry
is refused.

`deprecated` is how a curator withdraws an entry without delisting it. Both
screens mark the entry as no longer maintained, and an instance refuses to
install it anew with the reason `entry-deprecated` (409). An instance that
already has the plugin or theme can still reinstall it and take its updates,
so a board is never left unable to repair something it already runs.

An `id` appears once in the index, whatever the entry's type. An index that
lists one twice is refused as a whole, as is an index carrying any entry the
instance cannot read: a board installing from an index that silently lost an
entry could not tell it from one delisted on purpose. Every object in the index
is read strictly, so a field this version of the index does not define is
refused rather than ignored: a misspelled field of the declaration would
otherwise be replaced by its default before the consent screen showed it. A new
field is a new index `version`. A new value in an existing list, such as a
personal-data category, is not: an index whose entries do not use it reads as
it did. An instance too old to know the value refuses the whole index if any
entry uses it, whatever the version says. `@openbrf/plugin-sdk` exports the schema and
`parseCatalogIndex`, so a catalog's own check reads the index exactly as an
instance does.

The digest may be written as `sha512-<base64>` (what `npm pack --json`
reports) or as 128 hex characters (what `sha512sum` prints). A tarball whose
digest does not match is discarded, never unpacked. `@openbrf/plugin-sdk`
exports `parseSha512`, `formatSha512` and `IntegrityError`. `parseSha512` reads
a digest and throws an `IntegrityError` with `reason` `malformed-digest` when it
is neither spelling; `formatSha512` spells one. So a catalog's own check
accepts exactly the spellings an instance does.

### What a listing must meet

The curated catalog lists a package when:

- its artifact is an asset of an immutable GitHub release of the listing's own
  public repository, at
  `https://github.com/<owner>/<repo>/releases/download/v<version>/<file>.tgz`,
  the tag being `v` followed by the entry's version, and the release not a
  draft or a pre-release. That repository is the one its source lives in, or a
  release-only repository that builds it from source kept elsewhere (see "A
  release-only repository" below);
- the tarball carries a build attestation from that repository's release
  workflow, `.github/workflows/release.yml`, made by a run on a GitHub-hosted
  runner for the release's own tag, `refs/tags/v<version>` (see "The release
  workflow runs on the tag" below);
- the commits that attestation names, the source it was built from and the
  commit its workflow was read at, are on the repository's default branch;
- a package from a release-only repository names the source it was built from
  in a `source.json` at its root, a copy of the release repository's own;
- its size and digest are the ones the entry states;
- the package agrees with the entry: for a plugin the package name, version,
  id, API version, permissions, personal-data categories, actions, protected
  resource, recipients (each one's id, origin, purpose and categories, the
  board reading the entry's before anything is downloaded), whether it is an
  AI package, and the licence it reads with its release date; for a theme the
  name, version, contract and parent, the parent
  being the built-in theme or a theme in the same index;
- a theme that is not itself deprecated has no deprecated parent: neither its
  parent nor any theme further up its `extends` chain is marked `deprecated`,
  because `deprecated` is how the catalog stops offering an entry to new
  installs while keeping the ones already made, and a theme should not be newly
  offered on top of a parent that no longer is;
- the tarball is a gzip archive that holds files and directories only, within
  the limits an instance applies when it reads a theme package: at most 200
  files and 200 directory entries, no file over 4 MiB and no more than 8 MiB
  unpacked in all; every
  file's path as stored in the archive, relative, at most 200 characters
  (counting the `package/` directory `npm pack` adds, because the length is
  checked before the common root is stripped), with no `..` or empty segment
  and no backslash; and no symbolic or hard links, devices, FIFOs, or GNU
  long-name or pax extension records. The catalog reads a plugin's tarball
  with the same reader, so a plugin outside these limits is not listed,
  although an instance never reads a plugin with it. The four limits are
  `MAX_ARCHIVE_ENTRIES`, `MAX_DIRECTORY_RECORDS`, `MAX_ENTRY_BYTES` and
  `MAX_TOTAL_BYTES` in
  `@openbrf/theme-tools`; the 200 characters is a literal in its
  `assertSafePath`, not one of those constants. An author can run
  `readThemeArchive` on the packed tarball to check all of it;
- a plugin that reads a licence names an issuer that publishes it, declares
  only keys that issuer publishes, and declares no key id that another plugin
  in the same index declares with a different key (see "A licensed plugin"
  below);
- a plugin declares no runtime dependencies and passes the package check below;
  a theme passes the install lint.

The catalog repository's README states the same rules, how a listing is
proposed and how one is delisted, and its check runs them on every pull request
and every night.

`pluginPackageProblems` in `@openbrf/plugin-sdk` is the check a plugin's own CI
runs on the packed tarball. It reports, one sentence each, the manifest's own
issues; any runtime dependency; a host package declared as a runtime dependency
rather than a peer; a declared entry the package does not contain; a server
bundle that requires anything but the host packages, a path inside one and
Node's built-in modules, requires something other than a string literal, or
does not assign `exports.createPlugin`; and locale files that are missing or
whose keys differ. A package that passes returns none.

The check says whether a package installs and loads, not whether it is safe. A
plugin runs in the host's process with its privileges (ADR 0003), every Node
built-in is open to it, and code has ways to load a module that no reading of
the source follows. A plugin's server bundle is read by a person before its
listing is merged.

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

### The release workflow runs on the tag

The catalog verifies the attestation against the repository, the workflow that
signed it and the tag the run was made for (`gh attestation verify <file>
--repo <owner>/<repo> --signer-workflow
<owner>/<repo>/.github/workflows/release.yml --source-ref refs/tags/v<version>
--deny-self-hosted-runners`). An attestation from a run on `main`, on any other
branch, on a self-hosted runner, or by a workflow at another path is refused,
however correct the tarball is.

The catalog does not rely on how the installed `gh` matches those flags: before
gh v2.102.0, `--signer-workflow` matched a prefix, so a pin on `release.yml`
also accepted `release.yml.x.yml`. It reads every verified certificate from
`--format json` and requires each of these claims to be exactly the value
given:

| Claim                 | Value                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------- |
| `issuer`              | `https://token.actions.githubusercontent.com`                                          |
| `sourceRepositoryURI` | `https://github.com/<owner>/<repo>`                                                    |
| `sourceRepositoryRef` | `refs/tags/v<version>`                                                                 |
| `buildSignerURI`      | `https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/v<version>` |
| `buildConfigURI`      | the same as `buildSignerURI`                                                           |
| `runnerEnvironment`   | `github-hosted`                                                                        |

It then asks GitHub whether the commit the attestation names, both as the
source and as the commit the workflow was read at, is on the repository's
default branch, and refuses the listing when it is not. A tag push runs the
workflow as the tagged commit has it, so a check in the workflow that the tag
is on `main` guards against tagging the wrong commit by mistake, not against a
writer who tags a branch on which that check has been edited away. The
default-branch check moves that rule out of the code it is checking.

Being on the default branch means a commit was merged, not that it was reviewed,
and the catalog does not read a repository's settings. The check proves the
tagged commit is an ancestor of the default branch and nothing more. The
repository should therefore also have:

- a tag ruleset on `refs/tags/v*` restricting creation, update and deletion,
  which only the Admin role bypasses, so that whoever can merely push cannot
  make such a release at all.

A ruleset on the default branch that requires a pull request with at least one
approving review and approval of the most recent push is recommended, not
required, so that a change to `release.yml` is read by someone other than its
author before it can sign a release. Neither the catalog check nor the person
reviewing a listing holds a listing to it.

The person reviewing a listing confirms the tag ruleset.

Because the run is held to the tag, a plugin's or theme's release workflow is
started by the push of the `v<version>` tag (`on.push.tags: ["v*"]`). A run
started by hand is accepted only if it is dispatched on that tag's ref, and one
on `main` never is, so the tag push is the one start that cannot go wrong. The
workflow packs the tarball once, attests that file, and attaches that same file
to the release before the release is published, since the assets of an immutable
release cannot change afterwards. Its job needs the `id-token: write` and
`attestations: write` permissions to attest and `contents: write` to create the
release and upload the tarball; once a job has a `permissions:` block, every
permission it leaves out is `none`. The `sha512` and `bytes` the entry states
are those of that file.

The workflow creates and publishes the release itself. Do not publish a
release from the GitHub UI first: publishing a release with a new tag creates
that tag, the tag push then starts the workflow after the release is already
immutable, and the upload of the tarball fails. The repository also needs
GitHub's immutable releases setting turned on before it publishes its first
release, because the catalog refuses a release that is not immutable.

Because the catalog compares `buildSignerURI` and `buildConfigURI` whole, the
signing workflow must be `.github/workflows/release.yml` in the package's own
repository, and the run must be its own: `buildConfigURI` names the workflow
that started the run, so `release.yml` called as a reusable workflow by another
one is refused, as is a reusable workflow from another repository.

The core's own `.github/workflows/release.yml` is not a pattern for this. It
publishes the npm packages a plugin or theme is built against, runs by hand on
`main` and creates no tag, so an attestation made that way would be refused by
the catalog.

### A release-only repository

A package whose source is not public is listed from a public repository that
holds its release workflow and no source, and builds the package from source
kept elsewhere (ADR 0044). The rules above hold for it unchanged: the tarball is
an asset of that repository's immutable release, a public download, and the
attestation is made by that repository's own release workflow in a run on the
tag. An attestation made in the source repository is refused, because the
catalog holds the attestation to the repository the release is in.

The package carries a `source.json` at its root, beside its `package.json` or
`theme.json`, naming the repository its source is in and the full commit id it
was built from:

```json
{
  "repository": "https://github.com/<owner>/<source repository>",
  "commit": "<full commit id>"
}
```

The release repository pins the source it builds in a `source.json` of its own,
at its root, and the release workflow copies that file into the package
unchanged. The catalog reads the release repository's `source.json` at the
commit the attestation names as the source, and refuses the package unless its
own `source.json` has the same bytes, or has none when the release repository
pins none. It also refuses a record:

- that is not a JSON object with exactly those two fields, each named once;
- whose `repository` is not exactly `https://github.com/<owner>/<repository>`,
  without `.git`, a trailing slash or a further path. A source on another host
  is refused, because the check can ask only GitHub whether a repository is
  public;
- whose `repository` is the release's own repository;
- whose `repository` GitHub reports public. A package whose source is public is
  released from that repository;
- whose `commit` is not 40 or 64 lowercase hexadecimal characters.

It cannot read a private source, so it does not check that the commit exists. A
package without the file, from a release repository that pins none, is read as
built from the commit its attestation names; the maintainer reviewing the
listing refuses a release-only listing that leaves both out.

The record is in the tarball, not in the release notes, because the title and
notes of an immutable release can still be edited after it is published. The
attestation fixes the record but does not prove it: the release workflow
writes the package, so the record is the author's statement of the source,
pinned in the public history of the repository that signed it. Only someone who
can read the source and rebuilds the commit can check it. A plugin lists
`source.json` in its `package.json` `files` so `npm pack` keeps it; a theme's
install lint accepts it as a JSON file.

The pin is moved by a reviewed pull request for each release, and the tag is
pushed on the merge. A tag ruleset lets only the release repository's
maintainers create a `v*` tag, and nobody move or delete one. The release
workflow reads the pin at the tagged commit, checks out exactly that commit of
the source, builds and packs the package with the pin copied in, attests the
tarball and publishes the release. Reading the source takes a credential, held
like this:

- an **environment secret**, of an environment whose deployment rule allows
  only `v*` tags. A repository secret is open to every workflow and job in the
  repository, whatever environment a job names;
- one that reads the source repository and nothing else: a read-only deploy
  key, a GitHub App installation token minted in the run for that repository
  alone with `contents: read`, or a fine-grained personal access token limited
  to that repository with `contents: read`. Never a classic personal access
  token, which reaches every repository its owner can;
- used by a checkout with `persist-credentials: false`, so it is not left in
  `.git/config` for the build to read;
- held by a build job that has no `id-token` or `attestations` permission. A
  separate job, without the credential, takes the tarball from it, attests it
  and publishes the release.

The credential is never in the package or the release, and neither the catalog
nor an instance needs one.

### A licensed plugin

The plugin reads only the licences its `keys` verify, so the catalog vouches for
those keys with the issuer's own word. The issuer publishes, at the `url` its
licensed plugins name (see [Licences](#licences)), a document of exactly this
shape:

```json
{
  "format": "openbrf-licence-issuer/1",
  "name": "<the issuer's name>",
  "keys": { "<key id>": "<base64 of the 32-byte Ed25519 public key>" },
  "repositories": ["https://github.com/<owner>/<repo>"]
}
```

`repositories` lists the repositories the issuer's plugins are released from,
each written as the artifact URL writes it. The `url` is an exact `https`
address of a named host, written as a URL parser prints it (`new URL(url).href`,
so `https://example.org/`, not `https://example.org`): no credentials, no port,
no IP address and no `localhost`, and nothing a URL parser would rewrite. An issuer serves
the document at the address its plugins name, without a redirect: the catalog
reads it with a deadline and at most 64 KiB, without the GitHub token, and
refuses a redirect rather than following it, so the document is the one the
address answers. The catalog refuses a listing when:

- the document cannot be read, is not that shape, or names a field twice in
  one object;
- the plugin's `licence` is not a declaration of an issuer `name` and `url`
  and a `keys` object: one that declares no key, or a key that is not text, is
  refused;
- its `name` is not, exactly, the issuer's name in the plugin's `licence`;
- it does not list the repository the listing is released from, compared
  exactly: that issuer does not publish this plugin;
- a key in the plugin's `licence.keys` is not in its `keys` under the same key
  id;
- another plugin in the index, a deprecated one included, declares one of the
  plugin's key ids with a different key. A host tries a licence against every
  installed plugin's key with the key id the licence names and refuses one that
  none of them verifies, so a board that installed one of the two would have a
  licence for the other refused.

An entry repeats the plugin's `licence` and `released`, since the board
consents to the licence before anything is downloaded. The index schema does
not read `recipients`, `licence` and `released` on an entry yet, and it refuses
an entry that carries a field it does not know. Until it does, an entry cannot
carry them, so a licensed plugin cannot be listed, and the board cannot yet
read an entry's recipients before anything is downloaded.

## Operator configuration

| Variable                            | Default                                                               | Effect                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `OPENBRF_PLUGINS_ENABLED`           | `true`                                                                | When false, nothing is loaded or installable.                                                    |
| `OPENBRF_CATALOG_URL`               | `https://raw.githubusercontent.com/openbrf/catalog/main/catalog.json` | Where the catalog is read from. Leave empty for the curated index.                               |
| `OPENBRF_CATALOG_TOKEN`             | unset                                                                 | Bearer token for an index that requires one, sent to it and to artifacts on its own origin only. |
| `OPENBRF_UNCURATED_PLUGINS_ENABLED` | `false`                                                               | Required to point `OPENBRF_CATALOG_URL` anywhere but the curated index.                          |
| `OPENBRF_PLUGINS_REINSTALL_ON_BOOT` | `false`                                                               | Reinstall at boot when the data volume does not carry what the database says is installed.       |

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

## When an install fails

An install that does not converge leaves the plugin's row failed and the data
volume as it was. The row records why as one of the reasons below, with the
values its sentence needs, and the admin screen and `openbrf plugin list` say
it in the reader's language. What the installer threw is kept beside it, URL
and all, and `openbrf plugin list` prints it beneath the sentence. A row that
failed before an instance recorded reasons has only that text, and shows it.

Some of those values come from the archive itself, such as the name its
package.json gives. Each is stored cut to 214 characters, npm's limit on a
package name, and `openbrf plugin list` prints control characters in it as
escapes such as `\x1b` rather than passing them to the terminal.

| Reason                     | Meaning                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `download-budget-spent`    | The run's downloads used their whole time before this one began.          |
| `download-timed-out`       | The archive did not finish downloading in the time it was given.          |
| `source-not-allowed`       | The archive's address, or a redirect, is not a source the instance reads. |
| `source-unreachable`       | The release host could not be reached, or redirected nowhere usable.      |
| `source-answered-error`    | The release host answered with an HTTP error status.                      |
| `archive-too-large`        | The archive is larger than an instance accepts.                           |
| `checksum-malformed`       | The catalog states a checksum that is not a sha512 digest.                |
| `checksum-mismatch`        | The downloaded bytes do not hash to the checksum the catalog states.      |
| `download-failed`          | The download failed for a reason with no code of its own.                 |
| `archive-unreadable`       | The archive could not be unpacked to read its package.json.               |
| `archive-not-a-plugin`     | The archive's package.json is not an installable plugin package.          |
| `archive-package-mismatch` | The archive holds another package or version than the one consented to.   |
| `npm-install-failed`       | npm could not install the verified archives.                              |
| `package-not-installed`    | npm finished without installing a consented archive as a package.         |
| `unconsented-packages`     | npm installed packages no archive was consented for.                      |
| `installation-claim-lost`  | Another run took the installation over while this one was building it.    |
| `build-failed`             | Building the installation failed for a reason with no code of its own.    |

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
| `personal-data-widened`   | It handles personal data, or keeps records, beyond what was consented. |
| `actions-widened`         | It declares an action the board has not consented to.                  |
| `action-refused`          | An action it declares could not be registered.                         |
| `ai-changed`              | Whether it is an AI package is not what the board consented to.        |
| `block-refused`           | It registered a website block its manifest does not declare.           |
| `forbidden-injection`     | A provider, controller or enhancer reaches for a core service.         |
| `oauth-resource-conflict` | Another installed plugin already serves the OAuth protected resource.  |
| `not-consented`           | On the volume with no record of consent, or not the consented package. |
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
- `forbidden-injection` means one of the plugin's providers or controllers, or a
  guard, interceptor, pipe or filter a controller names by class, asks NestJS
  for a core provider, by constructor parameter or by an `@Inject()` field. Everything the platform's twelve `@Global()` modules export is
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
  one. A token is matched by name whether it is a class, a symbol or a string,
  and a class by every name on its prototype chain, so a subclass of a core
  service is refused as the service is.
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
