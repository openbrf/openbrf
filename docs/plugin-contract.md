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

| Permission                | Grants                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addressBook:read`        | Apartments, names, who is a resident and who is a member, and move-in and move-out dates.                                                          |
| `addressBook:readContact` | Additionally email addresses and telephone numbers.                                                                                                |
| `mail:send`               | Sending mail through the instance's configured SMTP server.                                                                                        |
| `sms:send`                | Sending text messages through the instance's configured SMS provider.                                                                              |
| `jobs:schedule`           | Registering workers and enqueuing or scheduling jobs.                                                                                              |
| `finances:read`           | The fee notification runs and their notices, the charges to members, and the events that say one was issued or changed. See [Finances](#finances). |
| `finances:recordDelivery` | Recording that a fee notice or a charge was delivered: a delivery receipt, never a payment. See [Finances](#finances).                             |

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

### Finances

`host.finances` reads the association's fee notices and charges to members,
records where a plugin delivered one, and tells a plugin when one is issued or
changed. It is the free half of the boundary ROADMAP.md publishes for advanced
finances: recording a charge, issuing notices and reading them are core, and so
is this. What carries a notice or a charge out of Open BRF - an accounting
system, a bankgiro file, a reminder, an approval step - is the plugin's own work.
[ADR 0028](adr/0028-finances-in-the-plugin-api.md) records why it has this
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
`actions` and, for a connector, `oauthProtectedResource`. A theme entry adds the
token `contract` range and the theme it `extends`, and names no package: a
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
field is a new index `version`. `@openbrf/plugin-sdk` exports the schema and
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

- its artifact is an asset of an immutable GitHub release of the repository its
  source lives in, at
  `https://github.com/<owner>/<repo>/releases/download/v<version>/<file>.tgz`,
  the tag being `v` followed by the entry's version, and the release not a
  draft or a pre-release;
- the tarball carries a build attestation from that repository's release
  workflow, made by a run on a GitHub-hosted runner for the release's own tag,
  `refs/tags/v<version>` (see "The release workflow runs on the tag" below);
- its size and digest are the ones the entry states;
- the package agrees with the entry: for a plugin the package name, version,
  id, API version, permissions, personal data categories, actions and protected
  resource; for a theme the name, version, contract and parent, the parent
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

The catalog verifies the attestation against the repository and against the tag
the run was made for (`gh attestation verify <file> --repo <owner>/<repo>
--source-ref refs/tags/v<version> --deny-self-hosted-runners`). An attestation
from a run on `main`, on any other branch, or on a self-hosted runner is
refused, however correct the tarball is.

A plugin's or theme's release workflow is therefore started by the push of the
`v<version>` tag (`on.push.tags: ["v*"]`). A run started by hand is accepted
only if it is dispatched on that tag's ref, and one on `main` never is, so the
tag push is the one start that cannot go wrong. The workflow packs the tarball
once, attests that file, and attaches that same file to the release before the
release is published, since the assets of an immutable release cannot change
afterwards. Its job needs the `id-token: write` and `attestations: write`
permissions to attest and `contents: write` to create the release and upload
the tarball; once a job has a `permissions:` block, every permission it leaves
out is `none`. The `sha512` and `bytes` the entry states are those of that
file.

The workflow creates and publishes the release itself. Do not publish a
release from the GitHub UI first: publishing a release with a new tag creates
that tag, the tag push then starts the workflow after the release is already
immutable, and the upload of the tarball fails. The repository also needs
GitHub's immutable releases setting turned on before it publishes its first
release, because the catalog refuses a release that is not immutable.

The catalog passes `--repo` to `gh attestation verify` without `--signer-repo`,
so the signing workflow must live in the package's own repository. A reusable
workflow from another repository is refused.

The core's own `.github/workflows/release.yml` is not a pattern for this. It
publishes the npm packages a plugin or theme is built against, runs by hand on
`main` and creates no tag, so an attestation made that way would be refused by
the catalog.

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
| `personal-data-widened`   | It handles a personal-data category not consented to.                  |
| `actions-widened`         | It declares an action the board has not consented to.                  |
| `action-refused`          | An action it declares could not be registered.                         |
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
