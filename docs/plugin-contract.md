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
| `personRecords`          | no             | The collections that hold records about a person. See [Records about a person](#records-about-a-person).                                                   |
| `blocks`                 | no             | The blocks it adds to the association's website. At most sixteen; declaring one asks for `site:blocks`. See [Website blocks](#website-blocks).             |
| `recipients`             | no             | Where it connects to outside the instance, and which personal data each place receives. At most eight. See below.                                          |

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

### Recipients

`recipients` names every place outside the instance the plugin connects to,
whether or not it sends personal data there
([ADR 0037](adr/0037-declared-outbound-hosts-and-secret-settings.md)):

```jsonc
{
  "openbrf": {
    "personalData": ["freeText"],
    "recipients": [
      {
        "id": "model-provider",
        "origin": "https://api.anthropic.com",
        "purpose": {
          "sv": "Skickar texten styrelsen ber om hjälp med till språkmodellen.",
          "en": "Sends the text the board asks for help with to the language model.",
        },
        "personalData": ["freeText"],
      },
    ],
  },
}
```

| Field          | Meaning                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | Lowercase letters, digits and single hyphens, two to thirty-two characters. Unique in the manifest.                                                                          |
| `origin`       | An `https` origin written as a browser writes one: lowercase, no path, no trailing slash, no credentials, and a port only where it is not 443. Unique in the manifest.       |
| `purpose`      | What the plugin connects there for, in Swedish and English, at most 500 characters each. Inline text rather than a key, because the consent screen shows it before download. |
| `personalData` | The categories that place receives, each one of the plugin's own `personalData`. Empty for a connection that carries none, such as fetching a list of models.                |

The consent screen lists each recipient by its host, with its purpose and what
it receives, and fills in the question about where the plugin sends personal
data from the ones that receive any (see
[Where the plugin sends personal data](#where-the-plugin-sends-personal-data)).

The declaration is consented to as a snapshot, compared by id, origin and
categories. A republished version that adds a recipient, moves one to another
origin or sends one more category is refused at load with
`recipients-widened` until the board consents again. One that sends a recipient
fewer categories loads, because its reach narrowed. A changed purpose is shown
on the next consent and is not refused: it is the plugin's wording, not its
reach.

The host's way to a recipient is `host.recipients.fetch` (see
[Reaching a recipient](#reaching-a-recipient)). It reaches the declared origin
and nothing else, and records every request that carries personal data.

A declaration is not a fence. A plugin runs at full process privilege (ADR
0003), so nothing in the host stops it opening a connection it did not declare.
What holds a listed plugin to its declaration is the catalog's review of its
server bundle (see [What a listing must meet](#what-a-listing-must-meet)).

## Permissions

| Permission                  | Grants                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `addressBook:read`          | Apartments, names, who is a resident and who is a member, and move-in and move-out dates. |
| `addressBook:readContact`   | Additionally email addresses and telephone numbers.                                       |
| `mail:send`                 | Sending mail through the instance's configured SMTP server.                               |
| `sms:send`                  | Sending text messages through the instance's configured SMS provider.                     |
| `jobs:schedule`             | Registering workers and enqueuing or scheduling jobs.                                     |
| `site:blocks`               | Adding blocks to the association's website, which anybody can read, account or not.       |
| `addressBook:proposeImport` | Handing a member list to the board for review. Not yet in a release; see below.           |

`site:blocks` excludes both address-book permissions: a manifest asking for it
beside `addressBook:read` or `addressBook:readContact` fails validation. What a
block renders is published to the street, and the website's promise that it
cannot publish a resident's details rests on there being no path from it to the
register ([ADR 0006](adr/0006-the-page-block-model.md)). A plugin that reads the
register and wants a website block is two plugins, or a core feature request.
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
because they are the product's own and a plugin is not a reason to relax them:

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

The consent screen asks the board, and fills in what the plugin's declared
[recipients](#recipients) can answer.

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

For a plugin that declares a recipient receiving personal data, the step
starts with "yes" chosen and the recipient field holding the declared hosts. The
classification is never chosen for the board: whether a party acts on the
association's instructions or decides its own purposes is not something a
plugin's declaration can say, and nothing installs until the board has said it.

Every other plugin is asked with no answer chosen, including one that declares
no personal data and one whose declared recipients receive none. A plugin runs
at full process privilege (ADR 0003), so its word is not ground for a default:
a pre-selected "no" would write "passes no personal data on" into the record on
the strength of a click. An entry in a version 1 index cannot declare
recipients at all.

Installing a plugin also writes it into the record of processing activities
(art. 30) with the categories the manifest declared, and with the hosts of the
declared recipients that receive personal data as the processing's recipients.
A recipient declared as receiving none is a place the plugin connects to, not a
recipient of personal data, and is not listed. Both are refreshed when the
board consents to a new version. Removing one closes
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

### Reaching a recipient

`host.recipients.fetch(id, path, init)` sends one request to a recipient the
manifest declares ([Recipients](#recipients)) and returns its answer:

```ts
const { apiKey } = await host.settings.read();

const response = await host.recipients.fetch("model-provider", "/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": String(apiKey) },
  body: JSON.stringify({ model, messages }),
  // The body carries personal data, so say which and about whom.
  disclosure: { personalData: ["freeText", "name"], subjects: [personId] },
});
if (response.status !== 200) {
  // A 4xx or a 5xx is an answer, not an error.
}
const answer = response.json();
```

It needs no permission: the declaration is what the board consented to.

**Where it goes.**

- Only to the origin of the recipient `id` names. An id the manifest does not
  declare is refused with `recipient-not-declared`.
- `path` starts with `/` and may carry a query. It is resolved against the
  origin, and one that would leave the origin is refused with `path-refused`:
  an absolute URL, a second leading slash, a backslash, or credentials.
- The origin's host goes through the instance's outbound address rules. A host
  that resolves to a loopback, private, link-local or otherwise non-public
  address is refused with `address-refused`, unless whoever runs the instance
  allows private hosts (see [Operator configuration](#operator-configuration)).
  The connection is made to the addresses that were checked.
- A redirect is followed only while it stays on the origin, at most five times,
  the way a browser follows one: a 303, or a 301 or 302 answering a POST, turns
  into a GET without the body. A redirect anywhere else is refused with
  `redirect-refused`, and nothing is sent there.

**What it sends.**

- `method` is `GET`, `HEAD`, `POST`, `PUT`, `PATCH` or `DELETE`, and `GET` when
  left out. A body on a `GET` or a `HEAD` is refused.
- `headers` are sent as given. `host`, `content-length`, `transfer-encoding`,
  `connection`, `expect` and the other hop-by-hop and `proxy-` headers are the
  host's to write and are refused.
- `body` is a string, sent as UTF-8, or bytes, at most 16 MiB.
- `timeoutMs` covers the whole exchange, name lookup and redirects included.
  It is 60 seconds when left out, and at most 300. The answer is read whole,
  at most 16 MiB, so a streamed answer arrives when it ends.

Each of these is refused with `request-refused` before anything is sent.

**A request that carries personal data** says so in `disclosure`:

- `personalData` names the categories the body carries. Each must be one the
  recipient's declaration receives. Naming any other, or sending any category
  to a recipient declared as receiving none, is refused with
  `personal-data-not-declared`.
- `subjects` names the persons the body is about, by id, at most 100. A person
  with protected personal data, a person under a restriction of processing and
  an id the register does not hold are all refused with `subject-refused`, and
  you are not told which. Pass an empty list for text that names nobody the
  plugin knows of, such as what a board member typed.

Both are checked before anything is recorded or sent. Then the host writes one
`PLUGIN_DISCLOSURE_STARTED` audit entry per subject, with the recipient, its
origin, the categories and the SHA-256 digest of the body, and commits them
before the request leaves. If they cannot be written, nothing is sent. When the
request settles it writes one `PLUGIN_DISCLOSURE_FINISHED` entry per subject:
`answered` with the recipient's status, or `failed` with the code. A disclosure
with no subjects is recorded once, naming nobody. The entries reach each
subject's data subject access report. They never carry the body, a header or
the path, so do not count on the log to say what was sent: the digest lets a
copy the recipient holds be matched.

A request without `disclosure` is recorded nowhere. That is right for fetching
a list of models or the day's exchange rates. It is wrong for anything about a
person, and the catalog's review of a listed plugin's bundle checks it.

A refusal or a failure throws `PluginRecipientError`, whose `code` is one of
the codes above, `unreachable` when no answer came, or `response-too-large`.
Its message names the plugin and the recipient's id, and never the path, a
header or the body.

`host.recipients` was added after this contract version shipped. A plugin built
against a newer host must feature-detect, as for
[`host.actions`](#actions):

```ts
if (host.recipients === undefined) {
  // This instance is older than the way out. Do without it.
}
```

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
| `secret`  | `minLength`, `maxLength`; no `default`                 |

Every field carries a `key` (a lowerCamelCase identifier), a `labelKey` and an
optional `hintKey`. Labels are i18n keys in the plugin's own namespace, not
inline text: a manifest carrying English prose would put an untranslatable
string on a Swedish-first screen.

`host.settings.read()` reads the current values on every call rather than
caching, so a value changed in the admin interface reaches a long-running
worker without a restart. A value whose field no longer exists is stripped.

### Secret fields

A `secret` field is for a credential: an API key, a token, the customer number
a plugin signs in with
([ADR 0037](adr/0037-declared-outbound-hosts-and-secret-settings.md)).

- **Write-only.** `GET /api/plugins/:id/settings` never returns its value. It
  returns `secretsSet`, the keys of the secret fields that hold one, and the
  form shows whether a value is stored. A save names a secret in `secrets` only
  to replace it (a string) or remove it (`null`); one left out is kept.
- **Encrypted at rest**, apart from the other values, with the instance's field
  encryption and bound to the plugin id and the key, so a ciphertext copied to
  another plugin or another field does not decrypt. This protects a database
  dump or a backup read without the instance's key. It does not protect a
  secret from the plugin it belongs to.
- **In clear only for the plugin**, in what `host.settings.read()` returns.
  Never write it to the log, a job's payload or anything a route returns.
- **Audited by key.** A change is recorded as `PLUGIN_SETTINGS_CHANGED` with the
  field's key and never its value.
- **No default**, because a credential in a published manifest is not a secret,
  and never empty: a secret is removed, not stored as `""`.

A required secret is satisfied by a stored value, so a save that leaves it out
keeps it, and a save that would leave it unset is refused. A website block's
settings may not declare a secret field: a block's values are stored in the page
and read by whoever renders it.

`host.settings.writeSecret(key, value)` replaces one of the plugin's own secret
fields, and `null` removes it. It is for a credential the far end replaces, such
as an OAuth refresh token that is new after every use. Only a field the manifest
declares as `secret` may be written, checked against its bounds; any other key
throws `PluginSecretFieldError`. The change is recorded on the `PLUGIN` audit
channel with nobody as its actor and the field's key as its detail. It was added
after contract version 1 shipped, so a plugin built against a newer host than
the one it runs on checks that the member exists before using it.

A field that an upgrade turns from `text` into `secret` is read as unset until
the board enters it again, and the plain copy the older version stored is
dropped at the next save.

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
`host.records`, is for configuration and never for people. The two never share
a collection.

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
`actions`, for a connector `oauthProtectedResource`, and in an index of version
2 `recipients`. A theme entry adds the
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
field is a new index `version`. A new value in an existing list, such as a
personal-data category, is not: an index whose entries do not use it reads as
it did. An instance too old to know the value refuses the whole index if any
entry uses it, whatever the version says. `@openbrf/plugin-sdk` exports the schema and
`parseCatalogIndex`, so a catalog's own check reads the index exactly as an
instance does.

An instance reads index versions 1 and 2 (`CATALOG_INDEX_VERSIONS`). Version 2
adds the plugin entry's `recipients`, and an index of version 1 that carries
the field, even empty, is refused. The catalog keeps serving version 1 for
instances that read nothing newer, listing only the entries that need nothing
from version 2 ([ADR 0030](adr/0030-plugins-that-extend-plugins.md)).

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
  resource and recipients; for a theme the name, version, contract and parent, the parent
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
listing is merged, and that reading is also what holds the plugin to its
[recipients](#recipients): a listed plugin connects to nothing outside the
instance that it does not declare, and sends personal data through
[`host.recipients.fetch`](#reaching-a-recipient) and no other way.

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

## Operator configuration

| Variable                            | Default                                                               | Effect                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `OPENBRF_PLUGINS_ENABLED`           | `true`                                                                | When false, nothing is loaded or installable.                                                                               |
| `OPENBRF_CATALOG_URL`               | `https://raw.githubusercontent.com/openbrf/catalog/main/catalog.json` | Where the catalog is read from. Leave empty for the curated index.                                                          |
| `OPENBRF_CATALOG_TOKEN`             | unset                                                                 | Bearer token for an index that requires one, sent to it and to artifacts on its own origin only.                            |
| `OPENBRF_UNCURATED_PLUGINS_ENABLED` | `false`                                                               | Required to point `OPENBRF_CATALOG_URL` anywhere but the curated index.                                                     |
| `OPENBRF_PLUGINS_REINSTALL_ON_BOOT` | `false`                                                               | Reinstall at boot when the data volume does not carry what the database says is installed.                                  |
| `OPENBRF_ALLOW_PRIVATE_HOSTS`       | `false`                                                               | Lets `host.recipients.fetch` reach a declared origin on a private network, as it does the SMS gateway and the mail servers. |

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
| `block-refused`           | It registered a website block its manifest does not declare.           |
| `forbidden-injection`     | A provider, controller or enhancer reaches for a core service.         |
| `oauth-resource-conflict` | Another installed plugin already serves the OAuth protected resource.  |
| `recipients-widened`      | It declares a recipient the board has not consented to.                |
| `not-consented`           | On the volume with no record of consent, or not the consented package. |
| `disabled`                | Switched off in the admin interface.                                   |
| `load-failed`             | It threw while being loaded.                                           |
| `not-on-volume`           | Recorded as installed but not present.                                 |

Five of these need an answer rather than a restart:

- `actions-widened` is the same gate `permissions-widened` and
  `personal-data-widened` are. The board consented to a stated set of actions,
  compared by the whole declaration rather than by id, so a republished version
  that keeps an id while changing the capability it needs has widened its reach.
  Reinstalling shows the new declaration for consent; arming starts from nothing
  afterwards.
- `recipients-widened` is the same gate on where the plugin connects to. The
  finding names the origins the board has not seen: a new recipient, one moved
  to another origin, or one that now receives a category it did not.
  Reinstalling shows the new declaration for consent.
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
