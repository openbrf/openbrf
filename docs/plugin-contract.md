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
    "processing": {
      "purpose": {
        "sv": "Visa styrelsen hur många som bor i huset, och var.",
        "en": "Show the board how many people live in the building, and where.",
      },
      "legalBasis": "legitimateInterest",
      "legitimateInterest": {
        "sv": "Styrelsens överblick över boendet.",
        "en": "The board's overview of who lives in the building.",
      },
      "retention": {
        "sv": "Ingenting sparas; registret läses vid varje visning.",
        "en": "Nothing is kept; the register is read on each view.",
      },
      "dataSubjects": ["members", "residents"],
    },
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

<!-- prettier-ignore -->
| Field | Required | Meaning |
| --- | --- | --- |
| `apiVersion` | yes | The contract version. Currently `1`. |
| `id` | yes | Lowercase letters, digits and single hyphens. It becomes a URL segment, an i18n namespace, a database key and a directory name, so no dots and no slashes. |
| `entry.server` | one of the two | Prebuilt CommonJS bundle exporting `createPlugin`. |
| `entry.client` | one of the two | Module Federation remote entry. |
| `permissions` | no | What the plugin asks the host for. Empty by default. |
| `personalData` | no | Which personal-data categories it will handle. Shown on the consent screen and written into the record of processing activities. See below. |
| `processing` | with data | What the processing of that data is for, on what basis, for how long and about whom. Declared with `personalData` and never without it. See below. |
| `view` | no | The exposed module name, the i18n key for its title, and the navigation section it is offered in. |
| `settingsSchema` | no | The settings form the host renders. |
| `actions` | no | What the plugin proposes the platform be able to do. At most sixteen, shown on the consent screen. |
| `oauthProtectedResource` | no | The route, under this plugin's own mount, that serves MCP. At most one installed plugin may declare it. |
| `deviceRoutes` | no | Routes under this plugin's own mount that a device reaches with a device token the board issues. At most four. See [Device routes](#device-routes). |
| `ai` | no | `true` for an AI package: a language model chooses the actions it dispatches. Its dispatch is recorded on the `ai` channel. See [Actions](#actions). |
| `personRecords` | no | The collections that hold records about a person. See [Records about a person](#records-about-a-person). |
| `blocks` | no | The blocks it adds to the association's website. At most sixteen; declaring one asks for `site:blocks`. See [Website blocks](#website-blocks). |
| `extensionPoints` | no | The extension points it offers other plugins. At most eight. See [Extension points](#extension-points). |
| `extends` | no | The extension points of other plugins it extends, which makes it an addon. At most eight. See [Extension points](#extension-points). |
| `recipients` | no | Where it connects to outside the instance, and which personal data each place receives. At most eight. See below. |
| `licence` | no | For a paid plugin: the entitlement it reads, its issuer, the issuer's keys and the services it may present the licence to. See [Licences](#licences). |
| `released` | with `licence` | The day this release was published, `YYYY-MM-DD`, compared with a licence's `updatesUntil`. |

Entry paths are relative and may not step outside the package.

`personalData` names everything the plugin handles, not only what it reads from
the register. A plugin that calls actions handles whatever those actions return,
so an assistant passing issue reports and minutes to a model provider declares
`freeText`, and one that reads charges declares `financial`. The host holds it
to that: a plugin is offered, and may invoke or propose, only the actions whose
own `personalData` its declaration covers ([Actions](#actions)). The categories
are the ones the association's own record of processing activities uses:

<!-- prettier-ignore -->
| Category | Means |
| --- | --- |
| `name` | Given and family name. |
| `apartment` | Which apartment and address a person is connected to. |
| `residency` | Move-in and move-out dates, and whether the person is a member. |
| `email` | Email address. |
| `phone` | Telephone number. |
| `postalAddress` | A postal address of the person's own, not the apartment's. |
| `personalIdentityNumber` | Personal identity number. Only with `addressBook:proposeImport`. |
| `account` | Sign-in credentials and sessions. |
| `financial` | Charges, debiting basis, and what a person owes or has paid. |
| `health` | Health, a special category under GDPR art. 9, where somebody has written it. |
| `photograph` | A photograph, whether or not anybody is recognisable in it. |
| `freeText` | Text a person wrote themselves, which may name anybody. |
| `auditTrail` | The audit log's record of who did what to whose data. |
| `protected` | Rows about persons with protected personal data. Only with `addressBook:proposeImport`. |

The plugin-level `personalData` list may name `personalIdentityNumber` or
`protected` only beside the permission `addressBook:proposeImport`, and must
name both with it: the installer, the catalog check and the install request
refuse a manifest or entry that does otherwise. A personal identity number is
never returned to a plugin, and a person with protected personal data never
appears in its reads, so for any other plugin a declaration of either would
describe something that cannot happen. A plugin that proposes an import carries
the member list towards the core, and the list can hold both ([Proposing an
import](#proposing-an-import)). An action's own `personalData` is a separate
declaration and may name them in any case (`protected` has its own rule,
below).

A plugin that asks for `site:blocks` may name only `freeText` and `photograph`,
since declaring any other category would offer it actions that return members'
details ([Permissions](#permissions)).

Installing the plugin writes these categories into the association's record of
processing activities (GDPR art. 30), as the categories that processing touches.
A declaration narrower than what the plugin actually handles makes that record,
and the consent the board gave, wrong.

### The processing declaration

A plugin that declares personal data declares what its processing of it is for
([ADR 0035](adr/0035-a-plugin-s-processing-and-objecting-to-it.md)), and a
plugin that declares none declares no `processing`:

<!-- prettier-ignore -->
| Field | Required | Meaning |
| --- | --- | --- |
| `purpose` | yes | What the processing is for, in Swedish and English, at most 500 characters each. |
| `legalBasis` | yes | `consent`, `contract`, `legalObligation` or `legitimateInterest`. The two art. 6(1) bases a plugin has no business with are not offered. |
| `legitimateInterest` | with `legitimateInterest` | The interest relied on, which art. 13(1)(d) requires on the privacy notice. Refused with any other basis. |
| `retention` | yes | How long the data is kept and when it goes, in both languages. |
| `dataSubjects` | yes | `members`, `residents` or both. |

Every object in it is read strictly, so a misspelled field is refused rather
than dropped. The consent screen shows the declaration before anything is
downloaded, and the install seeds the plugin's row in the record of processing
activities from it, in the association's own language: the purpose, the basis
with the interest relied on, the retention and the categories of people. A
plugin that declares no personal data gets no row, and a version that stops
declaring any ends the row an earlier one left. A plugin that asks for
`addressBook:read` or `addressBook:readContact` reads residents' personal data
whatever it declares, so it declares that data: the row is what a person
objects to, and without one nobody could.

The consent screen and `openbrf plugin add` both show the declaration before
the install, the command with `--dry-run` as well, and the install request
echoes it back, as it does the permissions. An entry that changed any field of
it between the screen and the install is refused. Within an echo, a `processing`
left out or null reads as "the screen showed none", so an entry that has since
come to declare one is refused rather than seeded. The install route requires
the echo, because its permissions, personal data, actions, recipients and
device routes are required fields, so every install through it is compared.

An install request that echoes no part of the declaration at all is not
compared, and the row is seeded from the catalog's current entry. Only code in
the API itself can make such a request, by calling the install service with no
more than the plugin's id. Such a caller is trusted to have shown the
declaration it installs. Neither the admin screen nor the command-line tool
does this.

The board's own edits on the data protection screen keep winning. A republished
version that changes the declaration refreshes the row only while no board
member has edited it; the consent step shows what the plugin now says either
way.

The declaration grants nothing: what a plugin may read is its permissions. It
is optional in the manifest schema, so a plugin published before the field
existed keeps loading and keeps the placeholder row it was seeded with, but
`pluginPackageProblems` reports a package that declares personal data without
it, or reads the address book and declares no personal data, and version 2 of
the catalog index refuses such an entry - so nothing is listed without one. A
plugin published before that rule that reads the address book keeps its row
whatever it declares.

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

<!-- prettier-ignore -->
| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits and single hyphens, two to thirty-two characters. Unique in the manifest. |
| `origin` | An `https` origin written as a browser writes one: lowercase, no path, no trailing slash, no credentials, and a port only where it is not 443. The host is a name: no IP address, `localhost` or trailing dot. Unique in the manifest. |
| `purpose` | What the plugin connects there for, in Swedish and English, at most 500 characters each. Inline text rather than a key, because the consent screen shows it before download. |
| `personalData` | The categories that place receives, each one of the plugin's own `personalData`. Empty for a connection that carries none, such as fetching a list of models. |

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

<!-- prettier-ignore -->
| Permission | Grants |
| --- | --- |
| `addressBook:read` | Apartments, names, who is a resident and who is a member, and move-in and move-out dates. |
| `addressBook:readContact` | Additionally email addresses and telephone numbers. |
| `mail:send` | Sending mail through the instance's configured SMTP server. |
| `sms:send` | Sending text messages through the instance's configured SMS provider. |
| `jobs:schedule` | Registering workers and enqueuing or scheduling jobs. |
| `finances:read` | The fee notification runs and their notices, the charges to members, and the events that say one was issued or changed. See [Finances](#finances). |
| `finances:recordDelivery` | Recording that a fee notice or a charge was delivered: a delivery receipt, never a payment. See [Finances](#finances). |
| `site:blocks` | Adding blocks to the association's website, which anybody can read, account or not. |
| `themes:install` | Installing and updating themes, for an administrator. See [Installing themes](#installing-themes). |
| `addressBook:proposeImport` | Handing a member list to the board for review, and nothing else. See [Proposing an import](#proposing-an-import). |
| `news:read` | The published news items, without who wrote them; see below. |
| `calendar:read` | The published events and the notices of the meetings called; see below. |
| `bookings:readAvailability` | The bookable resources and when each is taken. Never by whom; see below. |
| `media:read` | A stored picture by its id, only one declared to show nobody recognisable; see below. |
| `addresses:read` | The association's addresses, street and number, and nobody at them; see below. |

`site:blocks` excludes both address-book permissions and `finances:read`: a
manifest asking for it beside `addressBook:read`, `addressBook:readContact` or
`finances:read` fails validation. What a block renders is published to the
street, and the website's promise that it cannot publish a resident's details
rests on there being no path from it to the register ([ADR
0006](adr/0006-the-page-block-model.md)); a fee notice and a charge carry the
names of the people they are for. A plugin that reads the register or the
finances and wants a website block is two plugins that are not joined by
extensions at all, not even through a plugin they both extend (see
[Extension points](#extension-points)), or a core feature request.
`addressBook:proposeImport` is excluded beside `site:blocks` in the same way,
and so is a device route, because a plugin that proposes an import holds the
member list itself. The rules between plugins joined by extensions keep it
apart from a website plugin as well.

A plugin that asks for `site:blocks` also declares no personal data about the
members: its `personalData` holds at most `freeText` and `photograph`, the
published text and the pictures `news:read`, `calendar:read` and `media:read`
hand it. A plugin is offered, and may call, the actions whose personal data
its own declaration names ([Actions](#actions)), and some of
them return members' details to whoever on its route may call them:
`motion_queue_list` and the news comment actions return names. So a website
plugin that declared `name` could be handed names while a board member used
its route, and print them in a block, without any permission that reads the
register. A manifest that asks for `site:blocks` and declares any other
category fails validation (`blocks-declare-member-data`), and so does a catalog
entry. A category added to the list later is refused beside `site:blocks`
until it is added to the two allowed ones.

`freeText` is not all published text, though. A few core actions declare only
`freeText`: `motion_meeting_list`, `meeting_get`, `meeting_set_agenda` and
`issue_type_list` return text a member or the board wrote for the board, such
as the titles of motions, which may name somebody. A plugin that asks for
`site:blocks` is therefore not offered an action that declares `freeText` or
`photograph` unless the action is in the `news`, `menu` or `facts` group, whose
text and pictures the association publishes. A call to a core action that
declares either outside those groups is refused as `forbidden-surface`.
The core's page actions (the `pages` group) are refused to such a plugin in the
same way, whatever it declares and whether they read or write: the board sees
its pages with their drafts, and these actions answer with them or with the
summary of the page they touched, though they declare no `freeText`. This holds
whichever channel the call arrives on, an MCP token or an AI package included.
Another plugin's action that declares `freeText` or `photograph` is refused in
the same way: it returns what that plugin collected, and its author did not
write it for this plugin's blocks. Only the plugin's own actions are not held
to it.

Which permissions read the register is one classification in the SDK, not a list
repeated in each rule. Every permission is classified as reading it or not, a
permission added without a classification does not compile, and both exclusions -
`site:blocks` and `deviceRoutes` - follow it, so a new permission that reads the
register is refused beside them from the day it exists.

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

A person whose processing the association has restricted (GDPR art. 18) is
absent too, and so is a person whose objection to **this plugin's** processing
the board granted (art. 21, [ADR 0035](adr/0035-a-plugin-s-processing-and-objecting-to-it.md)).
The board records such an objection on the person's page, naming the plugin's
row in the record of processing activities, and the host carries it out: the
person is absent from every read the plugin makes through `host.addressBook`,
counts included, from the moment it is granted until the moment it is closed.
An objection to a host plugin's processing reaches what its addons read while
they answer its extension points ([Extension points](#extension-points)).
The plugin is not told that anybody objected, so it cannot list who did. An
objection to the association's mailings is a separate thing and does not take
anybody out of a plugin's reads. A plugin that keeps its own copy of the
register would defeat this, which is one more reason not to.

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
(art. 30), seeded from its processing declaration and with the categories the
manifest declared, and with the hosts of the declared recipients that receive
personal data as the processing's recipients. A recipient declared as receiving
none is a place the plugin connects to, not a recipient of personal data, and is
not listed. The categories and the recipients are refreshed when the board
consents to a new version. Removing one closes that processing while leaving the
recipient's classification standing for the board to close: the plugin is gone,
the fact that it once received data is not. A plugin that declares no personal
data is not written into that record.

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
`PluginHostUnavailableError`, `RequireCapability`, `REQUIRED_CAPABILITIES_KEY` and
`PLUGIN_ROUTE_CAPABILITIES`) are plain code, and the bundler inlines them:
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
`host.actions.invoke`, `host.actions.propose` and `host.actions.client` keep the
ordinary gate, and need no exception - a route serving a request means the
application is up.

### Reading the association's content

Five permissions read what the association has already published, or a fact
about the building, rather than the register
([ADR 0032](adr/0032-read-only-content-for-plugins.md)). Each is its own
consent: a board deciding about a weekly digest that reads the news has not
agreed to free/busy as well.

<!-- prettier-ignore -->
| Service | Permission | Answers |
| --- | --- | --- |
| `host.news.published()` | `news:read` | Published news items, newest first, at most 50 a call. |
| `host.calendar.occurrences()` | `calendar:read` | Occurrences of published events in a window of at most 92 days. |
| `host.calendar.meetingNotices()` | `calendar:read` | The notices of general meetings called and not yet held: time, place, agenda. |
| `host.bookings.resources()` | `bookings:readAvailability` | The bookable resources the house offers. |
| `host.bookings.busy()` | `bookings:readAvailability` | When each is taken in a window of at most 31 days, as merged intervals. |
| `host.media.open()` | `media:read` | One stored picture's type, size, checksum, audience and bytes, or `null`. |
| `host.addresses.list()` | `addresses:read` | The association's addresses, in the order of the address book's house tabs. |

```ts
const items = await host.news.published({ audience: "anyone", limit: 5 });
const week = await host.calendar.occurrences({
  from: "2026-11-02T00:00:00+01:00",
  to: "2026-11-09T00:00:00+01:00",
});
const taken = await host.bookings.busy({
  from: "2026-11-02T00:00:00+01:00",
  to: "2026-11-03T00:00:00+01:00",
});
```

Times are ISO 8601 instants with an offset, both ways. A window is half-open,
`[from, to)`. A value the contract does not allow - a window too long or
running backwards, a time without an offset or on a day the calendar does not
have, a `limit` outside 1 to 50 - is refused with a `RangeError`, which names
the parameter and never the value.

**What is there is what the core publishes.** A draft, an item taken down, a
series that is not published and a withdrawn resource are absent, and so is a
news item the board wrote to Styrelsen or Administratörer in the feed, which is
that audience's alone. An occurrence the board called off is present, with
`calledOff: true`.

**The audience travels with the item.** Every news item and occurrence says
whether it is for the members or for `anyone`, and `audience` narrows a read to
one of them. The host does not filter for you, because it cannot know where you
put an item: a screen inside the building may show a members' item, a public
calendar feed should not. Say which on your listing, since that is what the
board consents to.

**Nothing written about a person.** No author, comment, like or read count on
a news item. No sign-up or roll-call on an occurrence: `placesLeft` is a count.
No attendance, voting register, proxy or recipient on a meeting notice. No
booker, apartment or booking identifier on free/busy, and bookings that overlap
or touch come back as one interval, so a run of slots cannot be read as one
household's habits.

**The text is the board's.** A news item's paragraphs, an event's description
and an agenda's titles are returned as written, and may name somebody. A
manifest asking for `news:read` or `calendar:read` must therefore declare
`freeText` in `personalData`, or it fails validation. A news item's `pictures`
is empty: a news body is prose, and the website shows no picture in one.

**A plugin with a device route is given less.** A plugin that declares a device
route ([ADR 0031](adr/0031-a-device-token-for-a-plugin-s-own-routes.md)) puts
what it reads in front of whoever passes the device, so for it the host runs
the register check on every read. It checks every string an item carries: a
news item's title, paragraphs and picture alt texts; an occurrence's title,
description, category and location; a meeting notice's place, digital
participation and agenda titles; a bookable resource's name. It checks them
against the register as it is at the read: the given names, family names and
whole names of every person it holds, current and former, protected personal
data included; every email address and phone number it holds; and every
apartment number. A name or an apartment number matches as a whole word,
ignoring case, except that a given name matches only where it begins with a
capital letter, a name matches in the genitive as well (`Svenssons`), and an
apartment number of one character matches only after a word for an apartment
(`lgh 7`, `nr 7`). An email address matches whole, and a phone number by its
digits however they are spaced or dashed.

An item that matches is absent, whole, exactly as an unpublished item is, so
the answer alone tells you nothing about the register:

- a news read goes on to older items until it has as many as you asked for, as
  far back as the newest 500 published items, and returns what it has from
  those;
- an event is absent with every occurrence;
- a meeting notice with one matching agenda title is absent with the rest of
  it;
- a resource whose name matches is absent from `resources()` and from `busy()`.

An item for anyone is on the public website as well, though, so comparing the
two shows that some word of a public item is a word of the register, if not
which word or whose.

`busy()` also starts no earlier than the moment of the call, so a booking that
has ended is in no answer and one under way is taken from now. The check cannot
catch a name the register does not hold, a misspelt name, or a description that
identifies somebody without naming them. A plugin that shows published text on
a device should therefore still show only what the board picked for it. The
core's news, calendar, meeting and booking editors tell the board which items
are withheld from devices and which words caused it, so that it can rephrase
them.

**Show on screens.** Every news item and occurrence carries `onScreens`: whether
the board marked it, or the event it belongs to, "show on screens" in the core's
own editors ([ADR 0050](adr/0050-the-display-mode-and-one-renderer-for-every-screen.md)).
The mark is off until the board sets it, and its editor tells the board that an
item for a screen must name nobody. It is the board's pick for every screen in
the building, the core's display mode included, so a plugin that puts items
where anybody passing can read them shows the marked ones and keeps no pick of
its own. The host hands you every item with the mark and does not filter on it.

**A picture, and nobody in it.** `host.media.open(mediaFileId)` opens a picture
held for anyone or for the members whose upload declared that it shows no
identifiable person, and nothing else: not a document, not a household's or
the board's file, not a picture in the feed, and not a picture of people,
whose publication consent is for the website and not for wherever a plugin
puts it. Anything outside that rule answers `null`, exactly as a file that does
not exist, so the answer says nothing about a file you may not read. Nothing
lists the pictures: a plugin opens one whose id it already holds, such as one
the board picked in the plugin's own view.

```ts
const picture = await host.media.open(slide.mediaFileId);
if (picture !== null) {
  return new Response(picture.stream, {
    headers: {
      "content-type": picture.contentType,
      etag: `"${picture.checksum}"`,
    },
  });
}
```

`audience` says whether the picture is held for `anyone` or for the `members`,
as it does for a news item or an occurrence (see "The audience travels with the
item"). The host serves a members' picture to you all the same, since it cannot
know where you put it: a screen inside the building may show it, a public
page should not.

`stream` is a web `ReadableStream` of `Uint8Array` chunks; read it to the end or
cancel it, since the host holds the stored file open until one or the other. The
name the picture was uploaded under and who uploaded it are not handed over. A
picture is still a photograph, whoever is in it, so a manifest asking for
`media:read` must declare `photograph` in `personalData`, or it fails
validation.

**An address, and nobody at it.** `host.addresses.list()` answers each address's
`id`, `street` and `number`, and never an apartment or anybody living there,
which is `addressBook:read`. Neither it nor `bookings:readAvailability` needs a
category.

None of the five raises a route's capability floor above `self:manage`: what
they read is what anybody signed in may read already. Like `actions`, the
services were added after this contract version shipped, so a plugin that may
be installed on an older instance checks `host.news !== undefined` before using
them. A catalog entry asking for one of these permissions is refused by an
instance that does not know it, so the catalog lists it only in its version 2
index.

### The instance

A plugin that introduces the instance to a device or a service outside it, as
the signage plugin does in a screen's handover
([ADR 0034](adr/0034-digital-signage-on-the-public-plugin-api.md)), reads who
the instance is from `host.instance`:

```ts
if (host.instance === undefined) {
  // An older instance. Ask the board for what you need, or offer nothing that needs it.
} else {
  const { name, origin } = await host.instance.read();
  // name: "Brf Talgoxen", or null on an instance not set up yet
  // origin: "https://brf.example.se"
}
```

- **`name`** is the association's name as the board wrote it in the settings,
  without the spaces around it, at most 200 characters. It is read on every
  call, so a name the board changes reaches the plugin without a restart. It is
  `null` until the board has named the association. The host checks nothing
  else in it, so a plugin that hands it on under stricter rules, such as a
  shorter limit or no control characters, applies them itself.
- **`origin`** is the instance's public origin from the operator's
  configuration (`APP_URL`), written as the WHATWG parser writes an origin:
  scheme, lowercase host and a port only when it is not the scheme's default,
  with no path and no trailing slash. It is https on every instance apart from a
  development instance on a loopback address, which a plugin that hands it to a
  screen may refuse. A plugin's routes are under it, at
  `<origin>/api/plugin/<id>/`. Use it rather than the `Host` or `Origin` header
  of a request: those are what the caller sent, and a proxy in front of the
  instance may rewrite them.

It needs no permission. Neither value is personal data, since the association
is a legal person, and both are public already: the name heads the
association's website and every message it sends, and the origin is where the
plugin's own routes are served. The read keeps the ordinary gate all the same,
so it throws `PluginHostUnavailableError` from a constructor and after the
board switches the plugin off. It raises no route's capability floor.

`instance` was added after this contract version shipped. The SDK types it as
optional, so a plugin compiled against it has to check for it, and an older
instance has no such member.

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

None of `list`, `invoke` and `propose` takes a person. Each takes the request
the plugin's own route received, and the caller is read from a mark the host put
on it, so a plugin dispatches as whoever is on the other end of the request it is
serving and cannot dispatch as anybody else.

Nor can it reach personal data it has not declared. Through an action a plugin
is handed what the action returns, or hands over what its input carries, so
`list` leaves out, and `invoke` and `propose` refuse with `forbidden-surface`,
any action whose `personalData` names a category missing from the plugin's own
`personalData`: what its manifest declares, within what the board consented to.
The refusal's `details()` name those categories under `personalData`. (When a
plugin that asks for `site:blocks` is refused an action for the text it returns,
`personalData` names the `freeText` or `photograph` the action declares
instead; see [Permissions](#permissions).) This
holds for core actions, for another plugin's and for the plugin's own, and
whether the request on its route came with a session or with a connected app's
token. It is what keeps a plugin that has not declared names from being handed
names by an action a board member on its route may call: `motion_queue_list` and
the news comment actions return the names of members. It does not reach
categories the plugin has declared and the board consented to. A plugin that
declares `name` can call those actions while an authorised board member uses
its route, and what it receives is its to keep; that is what the consent screen
asks the board to weigh. A website plugin cannot be such a plugin, because a
plugin that asks for `site:blocks` declares no personal data about the members
([Permissions](#permissions)), and a plugin that does declare it is kept apart
from website plugins by the rules on extensions
([Extension points](#extension-points)).

This binds the plugin's server code, which is where `host.actions` is. It does
not bind its view. A view runs in the application's own page and origin, with
the signed-in person's session, so a request it makes to the core's own routes
reaches them as the person in the web interface does, with no plugin named on
it: neither this check nor the plugin's permissions apply to it, and what such a
request returns is the view's to send on to the plugin's own routes. The
host holds the server code to the manifest's permissions and `personalData`;
that the view keeps to them as well is left to the catalog's curation
([ADR 0003](adr/0003-plugin-loading-and-module-resolution.md)), as everything else about a
hostile plugin is, and no check of the host's enforces it.

#### Proposing a change instead of making it

`host.actions.propose` holds a write as a **pending change**
([ADR 0039](adr/0039-pending-changes.md)) rather than running it. Nothing is
written to the association's records. The person whose request it is sees the
change on the platform's own screen, field by field, and confirms or rejects it
there; on confirm it runs as them, on that moment's capabilities, with every
check the registry makes on any call made again.

```ts
const receipt = await host.actions.propose(request, "page_update", {
  id: page.id,
  expectedRevision: page.revision,
  blocks,
});
// { id, expiresAt, path: "/app/pending-changes/<id>" } - link the person there.
```

The proposal is checked as `invoke` would check it before running anything, and
refused the same way: the action exists and is offered, its plugin is serving,
the person holds its capability, and the input fits its schema. A read cannot be
proposed, and nor can an action that is not offered on the platform's own
screens (the `ui` surface), because it could never be confirmed. A plugin cannot
confirm, reject or read back a pending change: the routes that do are the
person's own and take the session cookie only. A change waits a week and then
lapses.

Where an action takes a precondition - `page_update`'s `expectedRevision` - put
it in the input. It is what refuses a change that was proposed against a page
somebody has since edited, rather than writing over their work.

A handler that refuses must have written nothing: refuse before the write, or
inside the transaction the refusal rolls back. A confirmed change whose action
refuses waits again, and the person may confirm it again once the refusal no
longer holds. A handler that fails in any other way, or returns what its output
schema refuses, ends the change, because its write may already stand. A plugin's
action proposed through a connected app or the AI package has to be still armed
when the person confirms it.

The mark ends with the response. Once the response is sent, or its connection
closes first, the request speaks for nobody, and `list`, `invoke` and `propose`
refuse it: a request kept and passed again from a job, a timer or another
person's request would otherwise name as the caller someone who is no longer
there. Dispatch before the route returns, and await it.

Nor does any of them take a channel. The host derives it from how the request
arrived and from the manifest. How the request arrived is what the authorization guard
established when it authenticated the request, kept apart from the request
itself: writing `principal` or `token` on it changes neither the person nor the
channel nor the connected app a dispatch is recorded as.

<!-- prettier-ignore -->
| The request on the plugin's route | A plugin | A plugin declaring `ai` |
| --- | --- | --- |
| A signed-in session | `plugin`, the `ui` surface | `ai`, the `ai` surface |
| A connected app's token | `mcp`, the `mcp` surface | `mcp`, the `mcp` surface |

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

The audit entry a dispatched write leaves names your plugin by its manifest id,
beside the person and the channel, whichever of the three it is, and the person's data subject access report
prints it. The host supplies the id, so a plugin cannot name another plugin. A
handler receives it as `context.pluginId` when a plugin's route made the call.

`list` names the actions the request it is given is offered, filtered by
channel, surface, capability, liveness and arming, as `invoke` is. Scope and
read-only mode are decided at `invoke`, which may still refuse a listed action.
Each entry carries the action's `inputSchema` and `outputSchema`, as JSON Schema
(draft 2020-12). They are the documents the HTTP catalogue publishes for one
action, the input schema is the one `invoke` validates against, and they are
what an MCP connector puts in `tools/list` or an AI package describes a tool to
a model with. Only the actions listed carry one, so a plugin cannot describe an
action the request is not offered. Each call builds them afresh, and a plugin may change
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

<!-- prettier-ignore -->
| Field | What it carries |
| --- | --- |
| `kind` | `registry` for the registry's own refusal, `invalid-body` for an input the schema refused, `domain` for the service behind the action |
| `reason` | One of `ACTION_ERROR_REASONS`, `invalid-body`, or the reason the action declared in its `errors` |
| `status` | The HTTP status the refusal answers with |
| `transport` | `protocol` or `tool-result`, from `ACTION_ERROR_MCP` |
| `retry` | `never`, `after-edit` or `after-backoff` |
| `details()` | The particulars: `scopes` for a missing scope, `issues` (path and message, never the value) for an invalid body, `personalData` (the categories the plugin has not declared for a plugin dispatch the declaration does not cover, or, when a plugin that asks for `site:blocks` is refused an action for the text it returns, the `freeText` or `photograph` the action declares) |
| `challenge` | For `insufficient-scope` only, the bearer challenge to send as `WWW-Authenticate` |

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
against a newer host than the one it runs on must feature-detect, and
`host.actions.propose` came later still:

```ts
if (host.actions === undefined) {
  // This instance is older than the member. Do without it.
}
if (typeof host.actions?.propose !== "function") {
  // This instance cannot hold a change for confirmation.
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

### Reading the register

`host.addressBook` reads the register on the terms of the permissions above:

```ts
const residents = await host.addressBook.residents({ addressId });
```

`residents()` returns the residencies held today. The optional `addressId`
returns only the residents of that entrance, so a plugin that shows one entrance
never loads the others; an id no address has returns nobody. Each resident
carries `name` and, beside it, `lastName` alone - for a plugin that shows a
household as the name on the door shows it, without the first names that say
who lives alone and name the children - and `nameInBuilding`, whether a
publication consent to the person's name on screens inside the building stands.
That is its own consent scope, recorded on the person's page like the others,
because a name in the stairwell and a name on the website are different things
to agree to.

The filter and the two fields were added after this contract version shipped.
`lastName` and `nameInBuilding` are additive; an older host ignores the filter
and returns every entrance, so a plugin that must not show the others filters
the result by `apartment.address.id` as well.

### Writing to the audit log

`host.audit.record` writes what the plugin did to the instance's audit log:

```ts
await host.audit.record(request, {
  event: "screen.residents-enabled",
  targetKind: "screen",
  targetId: screen.id,
  detail: { enabled: true },
});
```

The entry is written as `PLUGIN_RECORDED`, on the plugin channel, with the
plugin as its target, unless a `subject` is given: then the entry targets that
person and reaches their data subject access report. It carries the plugin's own
`event`, `targetKind`, `targetId` and `detail` in its context. With the request the plugin's route received, the actor
is the person the host marked on it, as for `host.actions`. With the request
one of its device routes received, the entry has no actor, since a device
names nobody. With `null`, the entry has no actor either - a job the plugin
scheduled, say. A request is refused once its response has been sent, and so
is one the host did not let through to one of your routes. No permission is needed
unless the entry names a `subject` (see
[Naming the person in an audit entry](#naming-the-person-in-an-audit-entry)).

`event` and `targetKind` are lowercase letters, digits, dots and hyphens,
starting with a letter, at most 64 characters. `targetId` is at most 200
characters. `detail` holds at most eight values, each a string of at most 200
characters, a number or a boolean, under a key of at most 64 letters and
digits that starts with a letter (`enabled`, `screenCount`). A field holding a
personal identity number is refused; each field is checked on its own, so a
number split across two fields is not caught, and keeping it out is yours. An
entry with a field outside these bounds is refused with a `RangeError` naming
the field, a `detail` key by its place (`detail[2]`) rather than its text, and
nothing is written.

The log is append-only, so how fast entries are written is bounded too, by
token budgets. Each holds a burst of entries and refills continuously at that
many a minute, and an entry refused for its fields or its `subject` spends from
none. The refusals for a spent budget are not `RangeError`s:

- Entries on the requests of one person share a burst of 30
  (`PLUGIN_AUDIT_LIMITS.perPersonPerMinute`), refilling at 30 a minute, with
  your plugin. That is well above what one entry per act of the person needs.
  The entry past it is refused with a `PluginAuditRateError`, nothing is
  written, and your plugin keeps running; answer the request as refused, a
  `429` say. The person spends this budget, so they are the one turned away.
  Recognise the error by its name (`error.name === "PluginAuditRateError"`),
  not with `instanceof`.
- Entries on the requests of one device, on your device routes, share a burst
  of 30 (`PLUGIN_AUDIT_LIMITS.perDevicePerMinute`), refilling at 30 a minute.
  The entry past it is refused with a `PluginAuditRateError` as a person's is,
  and your plugin keeps running. Each device has a budget of its own, so one
  device cannot use up another's.
- Entries with no request share a burst of 120 (`PLUGIN_AUDIT_LIMITS.perMinute`),
  refilling at 120 a minute. It is meant for your plugin's own jobs, so a plugin
  that writes past it is stopped with the finding `audit-rate-exceeded`: the
  entry is refused with a `PluginHostUnavailableError`, nothing is written, and
  every host service refuses the plugin until the application restarts, which
  switching it off and on again does. Refusing only the entries past the budget
  would still let a job writing in a loop add that many rows every minute for
  as long as the plugin ran. Never write `null` for each call a route answers:
  whoever calls that route then spends this budget, and can stop your plugin
  for everyone. On a device route, pass the request.

The entry is about what the plugin did - which screen the residents were
switched on for, and by whom - and never a copy of what it read: a person is
named as the actor or as the `subject`, never in the `detail`. The log is append-only and no purge
reaches it, so anything else written into it would be the one copy of a person's
data an erasure cannot reach.

The data subject access report prints the entry in the plugin's own words, from
the text key `audit.<event>` in its namespace, beside the plugin's id - so
`screen.residents-enabled` reads from `audit.screen.residents-enabled` in
`locales/sv.json` and `locales/en.json`. Without the key it prints the event
itself. The text is printed as written, at most 200 characters of it: the report
fills in no `{{value}}` and follows no `$t()`, so the text cannot print the
core's words, or another plugin's, as yours.

`host.audit` was added after this contract version shipped, like `host.actions`,
so a plugin built against a newer host must feature-detect it.

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

<!-- prettier-ignore -->
| Method | Answers |
| --- | --- |
| `notifications()` | Every fee notification run, newest period first, with its count and total. |
| `notification(id)` | One run with its notices, or `null`. |
| `charges({ from, to })` | The charges dated in a period, both ends inclusive, as `"YYYY-MM-DD"`. |
| `charge(id)` | One charge, or `null`. |

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
- **A charge to a household where somebody protected or restricted lives** -
  on the apartment itself, or on a person living there with them - withholds
  the board's reason, because what the board wrote about a household can name
  whoever lives in it. The household is the one living there on the day of the
  charge. The apartment stays, and so does the name of a person charged who is
  not protected or restricted themselves: the address book names that person
  at that door to any plugin that reads it. A notice withholds every name in that case,
  because it is for the household, and naming only some of it would misstate
  who it is for.

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
`{ state: "withheld" }`:

- on another plugin's receipt, always. A reference is that plugin's account of
  its own delivery, and the board consented to each plugin reading the books,
  not to each reading what the others wrote about them. The plugin, the route
  and the times stay.
- on a notice whose holders are withheld, and on a charge whose party or reason
  is. That follows the register as it stands at the read, not when the receipt
  was recorded: a reference written while a household could be named can name
  it as well as the names can, so it goes when they do.

The receipt stays either way, so a plugin can tell the row was delivered.
`recordDelivery` returns the reference visible, since it is what the plugin has
just stated.

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

`finances:recordDelivery` reads nothing on its own, but it raises a route's
floor as `finances:read` does: a receipt is written against a notice or a
charge, so a route that records one is held to the board's money capabilities.
A plugin that delivers also needs `finances:read` to know what to deliver.

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

<!-- prettier-ignore -->
| `type` | `version` | Carries | When |
| --- | --- | --- | --- |
| `feeNotification.issued` | 1 | `notificationId` | The board issued a period's notices. |
| `memberCharge.recorded` | 1 | `chargeId` | The board recorded a charge. |
| `memberCharge.corrected` | 1 | `chargeId` | The board corrected one. |
| `memberCharge.removed` | 1 | `chargeId` | The board removed one, receipts and all. |

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

The contract [ADR
0043](adr/0043-a-plugin-proposes-an-import-and-the-board-applies-it.md)
decided.

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
gives you JSON is written out as CSV first. A file holding the same rows as the
last one the board applied from your plugin, or as the one still pending, is
refused with `file-unchanged`, whatever its bytes. `sender` is optional free
text of at most 320 characters (longer is refused with `sender-too-long`, and
anything that is not text with `sender-invalid`); leave it out for a source
that has none. `fileName` is 1 to 255 characters
(otherwise `file-name-invalid`). `IMPORT_PROPOSAL_REFUSAL_REASONS` lists the
reasons this core refuses with; treat one you do not know as a refusal all the
same.

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

**Collecting from a relay.** A plugin whose file arrives at its publisher's relay
(a mailed list, say) pulls it: it connects out to the relay through a
[declared recipient](#recipients) with
[`host.recipients.fetch`](#reaching-a-recipient), keeps the relay's credential in
a [`secret` setting](#secret-fields), and acknowledges each file to the relay only
after `propose` has answered, whether it resolved or was refused. A file that was
not acknowledged stays with the relay, which keeps it until its own time limit,
so the next poll fetches it again. The core has no route a machine may call for
this: every plugin route needs a signed-in person, and a device route reads only.
A source that can only push is not served; it would need that route, which is a
decision of its own ([ADR
0043](adr/0043-a-plugin-proposes-an-import-and-the-board-applies-it.md), revisit
triggers).

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
  disclosure: { personalData: ["freeText"], subjects: [personId] },
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
it. The floor is every capability those permissions imply: `addressBook:read`
for either address-book permission, and both `fees:manage` and
`memberCharges:manage` for `finances:read`, because it reads both halves of
the books, and for `finances:recordDelivery`, because it writes against them.
A plugin with none of these is held to `self:manage`, which every account
has. A plugin joined to others by [extension points](#extension-points) is held
to the floor of its whole group's permissions instead of its own: an addon that
reads the register can hand its host plugin a name, and the host plugin can
hand it on to its other addons, so a host plugin that reads nothing is held to
`addressBook:read` while one of its addons reads the address book
([ADR 0052](adr/0052-the-route-floor-of-plugins-joined-by-extensions.md)).
The same floor holds for the plugin's actions. A controller may require **more** with `@RequireCapability`; it cannot
require less, and `@Public()` on a plugin route has no effect.
A route nobody signs in to is a [device route](#device-routes), which takes a
device token instead.

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
  async install(): Promise<void> {
    // ...
  }
}
```

A handler that throws is answered as a bad gateway and logged with the
plugin's id. A handler that throws an `HttpException` of its own is answered
with what it asked for.

### Device routes

A screen in the stairwell has no account and no session, and it should not
borrow a person's. A **device route** is a path under the plugin's own mount
that answers to a **device token** and to nothing else: a credential the board
issues to one device, which names the device and never a person (ADR 0031).

```jsonc
{
  "openbrf": {
    "id": "signage",
    "deviceRoutes": [{ "id": "screen", "path": "screen" }],
  },
}
```

`id` is lowercase letters, digits and single hyphens, two to thirty-two
characters, and a token is issued for one route by it. `path` is written as
`oauthProtectedResource` is and covers itself and everything below it, so the
route above is `/api/plugin/signage/screen` and every path beneath it. A path
is read segment by segment, as the router reads it: `screen%2Fcontent` is one
segment, and an ordinary `:id` route that takes it whole is not a device route
for being spelled like `screen/content`. A plugin declares at most four; two may not overlap, and none may overlap its
`oauthProtectedResource`.

**A plugin with a device route reads nothing from the register.** A manifest
that declares one beside `addressBook:read`, `addressBook:readContact` or
`finances:read` is manifest-invalid. What a screen on a wall shows, anyone
passing reads, and a fee notice and a charge carry the names of the people they
are for. For the same reason a plugin with a device route is never joined by
[extension points](#extension-points) to a plugin that reads contact details
or the finances, or proposes imports (`extension-device-group-refused`).

What a device route answers:

- **`GET` and `HEAD` only.** A plugin whose controller could answer any other
  method on a path under a device route is refused at load as `module-refused`,
  a parameter segment that could take the route's place included: `DELETE :id`
  on the plugin's mount answers `DELETE /screen`. The host answers the `OPTIONS`
  preflight itself.
- **`Authorization: Bearer <device token>` only.** The session cookie is not
  read there, so a board member's browser that opens the route is refused like
  anyone else. A token in the query string is never read.
- **One refusal for every failed token** - absent, unknown, revoked, or issued
  for another plugin or another route: a 401 with reason
  `device-token-invalid` and the challenge `Bearer realm="device"`.
- **404 while the plugin is not serving**, before the token is read: switched
  off, plugins switched off for the whole instance, refused at load, or
  removed. The token of a plugin that is switched off is kept. The 404 carries
  the headers below as every other answer does, on every path the board ever
  consented to as one of the plugin's device routes: a version refused for
  moving a route leaves the devices on the old path with a 404 they can read.
  The host keeps those paths apart from the plugin's row for the same reason,
  through later consents, a removal and a reinstall.
- **No person and no capability floor.** `host.actions.list` and `invoke`
  refuse a device's request, and a route's `@RequireCapability` is not read
  there.
- **Rate limited**: 120 calls a minute per token by default
  (`OPENBRF_DEVICE_TOKEN_CALLS_PER_MINUTE`), and thirty refused calls a minute
  per client address, answered 429 with `Retry-After`.
- **Cross-origin reads**: every answer, refusals included, carries
  `Access-Control-Allow-Origin: *` and exposes `ETag`, `Retry-After` and
  `WWW-Authenticate`, so a player packaged as a TV app or served from another
  origin can read it. `Access-Control-Allow-Credentials` is never sent. These
  are the only CORS headers the API sends.
- `Cache-Control: no-store` on every answer. Send an `ETag` and answer
  `If-None-Match` yourself if the device should not download what it has.

A device must read the 401 and the 404 differently. The 401 with
`realm="device"` is the only answer that says its token is gone, and only then
may it forget the token. A 404 says the plugin is not serving now: it stops
showing what it had, keeps its token and asks again later.

Tokens are issued, listed and revoked through `host.devices`:

```ts
@Controller()
class ScreensController {
  // A board member's own screen in the plugin's view, behind a session.
  @Post("admin/screens/:id/token")
  async pair(@Req() request: object, @Param("id") id: string) {
    const { token } = await host.devices.issue(request, {
      route: "screen",
      subject: id,
      label: "Entrance B, ground floor",
    });
    return { token }; // Hand it to the device. It is never shown again.
  }

  // The device's own route.
  @Get("screen/content")
  content(@Req() request: object) {
    const device = host.devices.current(request);
    return contentFor(device.subject);
  }
}
```

- `issue(request, { route, subject, label })` takes the request the plugin's
  own route received and reads the person from it, as `host.actions` does. It
  is refused (`device-token-issue-refused`, 403) unless the request came
  through the web interface - not a connected app's token, not a device - from
  a person who holds `site:manage` at that moment. `route` is the id of a
  declared device route. `subject` is the plugin's own handle on the device, 1
  to 64 letters, digits, `.`, `_`, `:` or `-`; `label` is the board's name for
  it, at most 80 characters. A plugin holds at most 200 live tokens. The token
  is `obrf_dt_` followed by 32 random bytes in base64url, returned once and
  stored only as its SHA-256 digest.
- `list(filter?)` returns the plugin's own tokens, newest first, revoked ones
  included, never the token.
- `revoke(tokenId, request?)` revokes one of the plugin's own tokens at once and
  returns whether it was live. Pass the request when a person asked for it, so
  the audit log names them.
- `current(request)` says which token a request on one of the plugin's device
  routes came with. It throws for any other request. The summary is frozen:
  copy it to change it.

A token has no expiry: a screen runs unattended for years. The board sees every
live token on the instance on the core's devices screen, under `site:manage`,
with the plugin, who issued it and when it was last used, and can revoke any of
them there, whatever the plugin's own screen says. Removing the plugin deletes
its tokens; switching it off keeps them; a republished version that drops a
device route revokes the tokens issued for it, and one that adds or moves a
route carries `device-routes-widened` until the board consents again. A
dropped or moved route's path keeps the headers above and the preflight, and
while the plugin serves it refuses a request that presents a token with the
same 401, whether or not the version serving mounts anything there, so the
device can read that its token is gone. Whatever the plugin mounts there now is
an ordinary route, which no device token opens. Where the path is now the
plugin's `oauthProtectedResource`, a connected app's token is answered there as
on any resource, and only a token the resource refuses that has a device
token's `obrf_dt_` form gets the device's 401.

`host.devices` was added after this contract version shipped, so a plugin built
against a newer host than the one it runs on must feature-detect it, as it does
`host.actions`.

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

The view runs in the application's page, as the signed-in person, and calls the
core's routes as that person: the plugin's permissions and the check on the
personal data its actions handle bind its server code, not its view (see
[Actions](#actions)).

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

<!-- prettier-ignore -->
| Section | Holds |
| --- | --- |
| `association` | The association and its life: the overview, news, the calendar, the general meeting. |
| `building` | The building and the apartments in it: issues, bookings, keys, subletting. |
| `board` | The board's own desk. Only destinations no resident is offered. |
| `settings` | How the instance is configured, and each account's own settings. |

The entry stands after the core's own destinations in that section, under the
view's title, and never in the phone's bottom bar. A plugin cannot add a section
of its own. The field is optional: a manifest without it is valid, and its view
stays reachable by its address alone, as every view was before the field
existed.

The board's section is the exception to "after the core's own destinations".
Its destinations are grouped by the kind of work - the front page, then queues,
registers, publishing, finances and data protection, one level - and a plugin's
entry there stands in the first group, queues, after the core's own queues and
before the section's other groups. A plugin cannot name a group. Where an
account is offered more than one destination in queues, the entry is under that
group's heading; where it is the only one, it stands without a heading, as any
group with one destination does.

Naming a section asks for an entry and does not grant one. The host offers the
entry only to an account that holds what the plugin's routes require - the
floor its permissions imply, or its group's for a plugin joined to others by
extension points, so a plugin reading the register is offered to the board and
the administrator and not to a resident - and in `board` only to the
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

<!-- prettier-ignore -->
| Type | Extra fields |
| --- | --- |
| `text` | `default`, `minLength`, `maxLength` |
| `number` | `default`, `min`, `max`, `integer` |
| `boolean` | `default` |
| `select` | `default`, `options` (each a `value` and a `labelKey`) |
| `secret` | `minLength`, `maxLength`; no `default` |

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
dropped when the plugin next starts serving.

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

<!-- prettier-ignore -->
| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | A lowerCamelCase word of at most 32 characters, unique within the plugin. The page stores the block under the type id `<plugin id>/<name>`. |
| `labelKey` | yes | The block's name in the editor, as an i18n key in the plugin's namespace. The add button reads "Add" and this name. |
| `icon` | no | One of `plugin` (the default), `paragraph`, `heading`, `image`, `form`, `news`, `calendar`, `documents`, `people`, `facts`, `contact`, `questions`. |
| `category` | no | Where the editor files it: `text`, `media` or `association` (the default). |
| `settingsSchema` | no | The settings the board fills in on each block, declared as [Settings](#settings) are. The editor draws the form. |

Each block on a page carries its own values, stored as `{ type, settings }`.
A save is held to the declaration while the plugin is serving: a value outside
it is refused with the path of the setting, and a setting the declaration no
longer has is dropped. A save never leaves a serving plugin's block out: it
carries the whole page, so leaving one out would delete it, or tell the board
"Saved." with the block gone. (Other unfinished blocks, such as a picture with
no file chosen, are still left out of a save.) While the plugin is serving, a
block on the page, new or already stored, whose required settings are
unanswered therefore refuses the whole save. This happens when the board has just added the block and not filled it
in, when a new version asks for a setting the block does not hold, and when
the plugin no longer offers the option the block holds. The editor names the
block and the settings it lacks, sends nothing, and keeps the block until the
board answers it or removes it. A block is held to the size an unregistered
block may have as well (10 000 characters of JSON), because that
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

<!-- prettier-ignore -->
| Kept | Elements |
| --- | --- |
| Text and its structure | `p`, `h2`, `h3`, `h4`, `ul`, `ol`, `li`, `dl`, `dt`, `dd`, `strong`, `em`, `small`, `code`, `blockquote`, `br`, `span`, `div`, `section`, `time` |
| Tables | `table`, `caption`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td` |
| Links | `a` |

<!-- prettier-ignore -->
| Attribute | On | Kept when |
| --- | --- | --- |
| `href` | `a` | It is `http`, `https`, `mailto` or a path on this instance. A link off the instance is given noopener noreferrer. |
| `dateTime` | `time` | It is a machine-readable date or time. |
| `scope` | `th` | It is `row`, `col`, `rowgroup` or `colgroup`. |

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

<!-- prettier-ignore -->
| Method | Answers |
| --- | --- |
| `get(collection, key)` | The record, or `null`. |
| `list(collection, { after?, limit? })` | The collection in key order, from after `after`. At most 200 records per call, which is the default. |
| `put(collection, key, value, { expectedRevision? })` | The record as written. |
| `delete(collection, key, { expectedRevision? })` | `true` when there was a record to delete, `false` when there was none. |

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
  such as an overwrite with a smaller value, is never refused by those three
  limits. The figures are exported as `PLUGIN_RECORD_LIMITS`, together with the
  one under "One at a time".
- **One at a time.** A plugin's writes run one after another, in the order it
  makes them, so a burst of them waits its turn rather than taking the
  database connections the rest of the instance needs. A write that throws
  does not hold up the ones after it. The host holds at most 100 writes of one
  plugin at once, the one under way and those waiting: a write sent while 100
  are held throws `PluginRecordLimitError` with the `limit` `queuedWrites`, and
  nothing is written, an overwrite included. A plugin that gets it waits for its earlier writes to
  settle before it sends more.

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

The host does not encrypt records, so what a plugin keeps here is readable by
anyone who can read the database. A credential, such as an API key for a service
of its own, belongs in a `secret` settings field, which is encrypted at rest (see
[Secret fields](#secret-fields)), not in a record.

### Switching off, removing, backups

Switching a plugin off keeps its records, and `host.records` throws
`PluginHostUnavailableError` until the plugin is switched on again, as every
host service does. Removing a plugin deletes its records, and the remove screen
says so before the board confirms. The host deletes them itself, in the
transaction that removes the plugin, rather than through a cascade from the
installed plugin's row: a record about a person under a legal hold or a
restriction is kept (see
[What the host does with them](#what-the-host-does-with-them)). A reinstall
starts with none of its own records. The records are in the instance's
database, so its backup carries them and a restore brings them back. Deleting a
plugin's row by hand, outside the remove, leaves its records behind.

Removing a plugin deletes its job queues as well: the jobs waiting on them, the
finance events not yet handed to it, its cron schedules, and their occurrences
not yet sent to it. A job the plugin was still sending as it was removed goes
with them: the removal waits for that send to finish before it deletes anything.
Where that fails, the next install under the id deletes them before it writes
anything, and refuses while it cannot, so whatever is installed
there later, the same package or another, starts with no jobs and no schedules.
A cron occurrence the removed plugin's schedule was already sending when it went
never reaches a handler under the id either: a job a schedule sends is handed
only to the handler of the queue that schedule was made for, not to one on a
queue made again under the same name. That covers a schedule made on an earlier
release too: the host gives it the queue it was made for when it starts, before
its first cron pass. That is also why an instance runs one release at a time,
stopping the old one before the new one starts (see
[deployment](deployment.md#what-happens-on-every-deploy)): a host still running
an earlier release against the same database would hand its handlers a cron
schedule's data together with the queue it was made for, rather than the data
alone.

Installing the same package again, at any version, keeps its records, its
settings and its job queues. A different package never takes them over: an instance refuses to
install one under the id of a plugin it already has, with the reason
`plugin-package-changed` (409), and the board removes the installed plugin
first.

`host.records` was added after this contract version shipped, so a plugin built
against a newer host than the one it runs on must feature-detect it, as it does
`host.actions`.

## Licences

A paid plugin is an ordinary plugin that reads an **instance licence** (ADR
0042): a small file its issuer signs for one instance, entered once on the
licence screen (`/board/licences`, under `association:manage`) or with
`openbrf licence add <file>`. The host verifies it offline, against the keys the plugin's manifest declares
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
  which is still Proposed). An instance never reads the document.
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

### Consenting to it

A plugin's `licence` is a grant the board consents to, as it does
`permissions`: `present()` gives the plugin a presentation signed by the
instance key, which the plugin sends to a service in its `audiences` to show
that the association holds the entitlement. So the catalog entry
repeats `licence` and `released`, the consent screen says that the plugin needs
a licence from its issuer and does nothing without one and names each audience,
and the install request echoes the declaration back, which refuses an entry
that changed between the screen and the install.

The instance records the entitlement, the audiences, the issuer and the
fingerprint of each key of the catalog entry the board installed, and the boot gate holds the
installed manifest to them. Until the board installs it again and so consents
to the new declaration, the gate refuses a version that:

- reads another entitlement, declares a licence where the board consented to
  none, names an audience outside the consented ones, or declares a key outside
  the consented ones, as `licence-widened`;
- names another issuer, or no longer declares a key the board consented to,
  as `licence-issuer-changed`.

Fewer audiences, or no licence at all, loads. Keys are compared by fingerprint,
so a key under another key id is the same key. The gate refuses a package that
disagrees with the catalog entry the board installed, so a rotation the
catalog publishes in one release, which the board installs, passes. A package
refused over its issuer or keys keeps no manifest, even if it is also disabled or refused for another reason, so its keys verify no
licence. And the licence screen and `openbrf licence` apply this test again
against the consent as it is at that moment, so once the board has consented
to an update with other keys, or removed the plugin, the old key verifies
nothing and the plugin is not listed among the licensed plugins, even before
the next start.

When a catalog release is published after the `updatesUntil` of the licence the
instance holds, and no other licence covers it, the update screen says so
before the board updates: the plugin is dormant on that release until a licence
that covers it is entered.

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

<!-- prettier-ignore -->
| `status` | Means |
| --- | --- |
| `active` | A licence covers today and this release. Carries its id and both dates. |
| `absent` | No licence the plugin's keys verified names the entitlement. |
| `expired` | Today is after its `validUntil`. |
| `version-not-covered` | This release was published after its `updatesUntil`. An earlier one is covered. |
| `wrong-instance` | It was issued to another instance, by id or by key. |
| `tampered` | It verified when it was entered and no longer does. |
| `not-yet-valid` | It was issued after today: a wrong clock on one side or the other. |

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

> Decided in [ADR 0047](adr/0047-a-plugin-s-records-about-a-person.md). On an
> instance from before it, `host.personRecords` is `undefined`, and the feature
> check below is what a plugin sees.

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

<!-- prettier-ignore -->
| Field | Required | Meaning |
| --- | --- | --- |
| `collection` | yes | Lowercase letters, digits and single hyphens, at most 32 characters. Not also used with `host.records`. |
| `titleKey` | yes | The collection's heading on the access report, a text key in your namespace. |
| `personalData` | yes | The categories its records hold, each among the manifest's own `personalData`. Never `personalIdentityNumber` or `protected`. |
| `keepAtMostDays` | yes | The longest a record may be kept, counted from the day it is written. 1 to 1 830. |
| `fields` | no | The top-level keys of a value the access report labels, each with a `labelKey`. A key not listed here is still printed as stored. |

A field's `key` is 1 to 64 letters, digits, `_` or `-`, starting with a letter,
and a collection names at most 32 fields, each once. The declaration is read
strictly: a misspelt key such as `provied` is refused rather than dropped.

Mark a field `"provided": true` when the person gave it to you, as the claimer
gives the space and the days. The portability export carries only those fields
(see "What the host does with them"). A field you set yourself, such as a
status, gets no mark: it is printed on the access report and stays out of the
export.

At most eight collections. A manifest with `personRecords` also declares
`processing` (ADR 0035), because every record has to belong to a row in the
association's record of processing activities, and asks for `addressBook:read`
(or `addressBook:readContact`), because whether a write naming a person is
accepted tells your plugin whether the address book lists that person. A
manifest or a catalog entry without either is refused. The catalog entry
carries `personRecords` in version 2 of the index, beside `processing`. The
consent screen and `openbrf plugin add` name each collection with its
categories and its bound, and the install echoes them back, which refuses an
entry that changed between the screen and the install. A republished version that adds a
collection, widens a collection's categories or lengthens its `keepAtMostDays`
is refused at load as `personal-data-widened`, as a wider `personalData` is,
and the finding names the collection. One that keeps less, or for less time,
loads.

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
- `eraseOn` must come after the day of the write and no later than
  `keepAtMostDays` after it. Today or an earlier day is refused with a
  `RangeError`: delete the record instead. A later day is refused with
  `PluginRecordRetentionError`. Rewriting a record may move it, within the same
  bounds. The day of the write is the day the write runs, after it waited in
  the queue below and for its locks, so a write sent just before midnight is
  judged on the next day.
- A new record's subject must be somebody `host.addressBook.residents()` would
  list to your plugin at that moment. Anybody else is refused with
  `PluginRecordSubjectError`, and the error does not say why. A record that
  already names a person can be rewritten with the same subject after that
  person has moved out.
- `list(collection, { subject })` returns one person's records, and without a
  subject it pages through the whole collection in key order, 200 at a time.
- The value is a JSON object of at most 64 KiB, refused with a `TypeError`
  otherwise. The records of both stores count towards one limit per plugin,
  10 000 records and 16 MiB, and a write past it is refused with
  `PluginRecordLimitError`. Writes of both stores wait in one queue, at most 100
  at a time.
- A collection your manifest does not declare under `personRecords` is refused
  with a `RangeError`, and so is one it does declare when it is reached through
  `host.records`. A `subject` that is not a person id, 1 to 64 letters, digits,
  `_` or `-`, is refused with a `RangeError` as well, without its value in the
  message.

Relate two people with two records rather than one. The offer is the holder's
record and the claim the claimer's, and the claim's key or value carries the
offer's key. Erasure, restriction and the access report act on whole records,
so one record about two people would go with the first person's erasure.

A record names nobody but its subject. A write whose key, property names or
string values hold another person's id is refused with
`PluginRecordOtherPersonError`, whoever that person is, because the access
report prints the record to its subject. So key an offer by an id your plugin
makes, not by the holder's person id, or the claim that carries it is refused.
The host finds an id on its own, set off by other characters as in
`offer:<id>`. An id of letters and digits alone, as the register makes them, is
found joined to a word with `-` or `_` too, as in `holder-<id>`; an id that
itself holds `-` or `_` is found only where it is set off.

**Refer to the register and do not copy it.** Store the person id and read a
name or an address again when you need one. Never store an email address or a
telephone number in a value: the core encrypts both, and a record's value is
not encrypted. A personal identity number is refused on every write.

### What the host does with them

- **Erasure on the day.** A record leaves your plugin's view at the start of its
  `eraseOn`: `get` and `list` no longer return it, `delete` answers `false`, it
  no longer counts towards your limits, and its key is free for a new record.
  Every night at 03:50, after the core's own purges and before the run that
  closes granted erasure requests, the host deletes every record whose
  `eraseOn` has come, from every plugin, installed, switched off or removed.
  The audit log gets one `PLUGIN_RECORDS_PURGED` entry for a run that deleted
  anything, with counts per plugin and collection and no person.
- **Erasure on request.** When the board grants a person's erasure request, the
  same run deletes every record about them, set-aside versions included, and
  the request is not closed while any is left: the closing run counts them as
  it counts the core's own records.
- **Legal hold and restriction.** Neither run touches the records of a person
  under a legal hold or a restriction. If your plugin deletes or overwrites such
  a record, the write succeeds, and the host sets the old version aside: it is
  gone from your reads and stays on the person's report until the hold has ended
  and its erase date has passed. To your plugin it looks like an ordinary write.
  An overwrite gives the new value the next revision, and a delete frees the
  key, so a create-only write onto it succeeds. Of the versions one key holds
  about the person on one day, the host keeps the one the day's first write
  replaced, and later writes that day replace in place what the earlier ones
  wrote. A record the hold keeps past
  its erase date is gone from your reads on that date, as anyone's is. Versions
  set aside and records past their date do not count towards your limits, so a
  store at its limit refuses the same writes whether or not a hold stands.
- **Records you cannot see.** A record whose subject has protected personal
  data, is under a restriction, or has objected to your plugin's processing is
  absent from `get` and `list`, and `delete` answers `false`. Its key stays
  taken, so a write onto it is refused as a conflict whose `actualRevision` is
  `null`: the key is held by a record you cannot read, until its erase date. A
  moved-out person's records stay visible until their erase date. So a plugin
  that keeps a record about a person learns when that person becomes withheld
  from it, as against moving out, though not which of the three reasons it is.
  The address book alone does not tell those two apart. The catalog's review
  therefore reads a server bundle's writes to `host.personRecords` for a reason
  in the plugin's features: a plugin that keeps a record about every resident,
  or about people its features have no use for, is not listed.
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
  they do not count towards its limits. Switching it off deletes nothing.
  The `PLUGIN_REMOVED` entry says how many records the removal deleted and how
  many it set aside.

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

`host.audit.record` (ADR 0035) takes an optional `subject`, held to the rule a
record's subject is: a person `residents()` lists to your plugin, or one a
record of yours that you can read is about, so a moved-out person's withdrawn
claim can still be recorded. Anybody else is refused with
`PluginRecordSubjectError` and nothing is written. Naming a subject needs
`addressBook:read` or `addressBook:readContact`, because whether it is accepted
tells your plugin whether the address book lists that person. Without either,
an entry with a `subject` is refused with `PluginPermissionError`; an entry
without one needs no permission. The entry then names that person as its
target, and it reaches their access report. The `detail` still never names a
person. The host records nothing for an ordinary write, so record the acts that
matter yourself, such as a claim made or an offer withdrawn.

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

## Extension points

A plugin can offer other plugins a slot to fill, and a plugin can fill another
plugin's slot ([ADR 0030](adr/0030-plugins-that-extend-plugins.md)). The slot
is an **extension point**, the plugin that offers it is the point's **host
plugin**, a plugin that fills it is an **addon**, and what the addon registers
there is a **contribution**: a title and a handler. Digital signage offers
`source`, a content source for a screen's rotation, and an addon that shows the
residents of an entrance contributes to it.

An addon is a plugin in every other respect. It is installed from the catalog,
consented to, switched on and off, and removed by itself, with its own
permissions and its own personal data. It never receives the host plugin's
permissions, and the host plugin never receives the addon's. What crosses
between them is data the host copies, in the shapes the host plugin's schemas
name. Because that data can be anything an addon read, every plugin joined by
extensions has its routes and actions held to the floor of the whole group's
permissions (see [Routes](#routes)): a host plugin whose addon reads the
address book answers only the board and the administrator. The addon's consent
screen and `openbrf plugin add` name each installed plugin whose floor the
install raises, before the board consents.

### Declaring a point

The host plugin declares each point in its manifest:

```jsonc
{
  "openbrf": {
    "id": "signage",
    "personalData": ["name", "apartment"],
    "extensionPoints": [
      { "id": "source", "version": 1, "personalData": ["name", "apartment"] },
    ],
  },
}
```

<!-- prettier-ignore -->
| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lowercase letters, digits and single hyphens, 2 to 32 characters, unique within the plugin. |
| `version` | yes | An integer from 1: the point's major version. |
| `personalData` | no | The categories a contribution may hand the host plugin through this point. Empty by default. Must be among the host plugin's own `personalData`. |

What an addon hands the host plugin is handled by the host plugin as much as
what it reads itself, so a point's categories are among its own and are on its
consent screen: "other plugins may add to it at Source, which accepts names and
apartments". Declaring a category grants nothing; reading the register still
takes an address-book or finance permission.

A plugin that declares `deviceRoutes` declares no point that accepts `email` or
`phone`. A device is a screen on a wall, and a device token reaches the plugin's
routes, so a point that accepted contact details would let it reach them through
an addon. The manifest is refused with the point's `personalData` named, and the
catalog refuses an entry that does the same.

A plugin that asks for `site:blocks` declares points that accept no personal
data at all. What a website block renders is published to anybody, and
`site:blocks` already keeps such a plugin away from the address book and the
finances; a point that accepted names would be the same path through a second
plugin. For the same reason an addon that asks for `addressBook:read`,
`addressBook:readContact`, `finances:read` or `addressBook:proposeImport` does
not extend such a plugin at all, whatever its `extends` says it hands over: its
own declaration would be all that stood between the register, or the member
list a plugin that proposes an import holds, and the website. Nor does an addon
that asks for `site:blocks` extend a plugin that reads the address book or the
finances, or proposes imports: the point's input, which no manifest declares,
could hand it names to render. The catalog refuses
an index that offers either pair, and the loader refuses the addon with
`extension-permission-refused`.

A website addon also extends only a plugin whose own `personalData` is empty.
A host plugin that reads nothing in the register can still be handed names by
another of its addons and pass them on as a point's input; one that handles no
personal data has none to pass on. The loader refuses the addon otherwise with
`extension-host-personal-data-refused`.

And the plugins joined by extensions are read as one group: an addon, the
plugins it extends, their other addons, and on through any addon that extends
two plugins. A group never holds both a plugin that asks for `site:blocks` and
one that reaches the members' details: one that reads the address book or the
finances, proposes imports, or declares personal data about the members, that
is any category but `freeText` and `photograph`. An addon that reads the address
book or the finances, or holds the member list it proposes, can hand its host
plugin a name while declaring nothing, and so can one that declares `name` and
is handed names by an action such as `motion_queue_list` while a board member
uses its route; the host plugin can hand the name to a website addon at another
point. Where a group would hold both, the loader refuses addons with
`extension-group-refused` until it does not. Among each host plugin and the
addons that extend it alone, the website addons give way first, then the
addons that reach the members' details; then, across the group, the addons that
join two of its plugins. An addon that declares `name` with no permission and
extends a website plugin is such a group of two, and is refused with
`extension-group-refused` rather than `extension-permission-refused`, which
names permissions alone. Installing an addon that joins a host plugin with
website addons to one with addons that read the address book or the finances
refuses that addon, and leaves the addons of either host plugin serving. A host
plugin is never refused by this rule, since its other addons would go with it.
The loader reads every addon before any of them loads, so the same ones are
refused whatever order it finds the packages in, and the catalog refuses an
index whose plugins would form such a group.

A group also never holds both a plugin that declares
[device routes](#device-routes) and one that asks for `addressBook:readContact`,
`finances:read` or `addressBook:proposeImport`
([ADR 0052](adr/0052-the-route-floor-of-plugins-joined-by-extensions.md)). A
point on a plugin with device routes accepts no contact details, but only the
addon's own `extends` says what it hands over, and an addon that reads contact
details or the finances could answer with them in any field the point types as
text, for a screen in the stairwell to show. An addon that asks for
`addressBook:read` alone may extend such a plugin: names and apartments on the
screen in the entrance are what signage's residents addon is for. Where a group
would hold both, the loader refuses addons with
`extension-device-group-refused` in the same order as above: the addons that
declare device routes first, then the addons that read contact details or the
finances, or propose imports, then the addons that join two of the group's
plugins. This rule is read among the addons the website's rule left, so an addon
is refused once, and the catalog refuses an index whose plugins would form such
a group.

### Declaring what an addon extends

```jsonc
{
  "openbrf": {
    "id": "signage-residents",
    "permissions": ["addressBook:read"],
    "personalData": ["name", "apartment"],
    "extends": [
      {
        "plugin": "signage",
        "point": "source",
        "version": 1,
        "personalData": ["name", "apartment"],
      },
    ],
  },
}
```

<!-- prettier-ignore -->
| Field | Required | Meaning |
| --- | --- | --- |
| `plugin` | yes | The id of the host plugin. |
| `point` | yes | The id of the extension point. |
| `version` | yes | The point's major version the addon was written against. |
| `personalData` | no | The categories the contribution hands the host plugin. Must be among the addon's own `personalData`. |

An addon names each pair of plugin and point once and never names itself. A
plugin that declares `extends` declares no `extensionPoints`: an addon cannot be
extended in turn. Its consent screen says what it extends and what it hands
over - "extends Digital signage at Source, and hands it names and apartments" -
beside its own permissions and personal data.

### Defining and contributing

The host object carries `host.extensions`. The host plugin defines the schemas
of each point it declares and calls the addons serving there; the addon
contributes its handler:

```ts
// The host plugin, in its module factory.
host.extensions.define("source", {
  input: z.strictObject({ screen: z.string() }),
  output: z.strictObject({
    items: z.array(z.strictObject({ text: z.string() })),
  }),
  timeoutMs: 5_000,
});

// Later, from onModuleInit onwards.
for (const contribution of await host.extensions.list("source")) {
  const result = await host.extensions.invoke<{
    items: { text: string }[];
  }>("source", contribution.addon, {
    screen: "entrance-a",
  });
  if (result.ok) {
    show(result.value.items);
  }
}
```

```ts
// The addon, in its module factory.
host.extensions.contribute(
  { plugin: "signage", point: "source" },
  {
    titleKey: "source.title",
    handler: async (input: { screen: string }, context) => ({
      items: await residentsOf(input.screen, context.signal),
    }),
  },
);
```

`define` and `contribute` are declarations. They are callable from the module
factory and are buffered until the application exists, as `host.actions.register`
is. A definition or a contribution the host cannot accept stops the plugin with
`extension-refused`: a point or a target the manifest does not declare, a second
one for the same point, a schema that is not a strict object at every depth
built with the host's `zod`, a `timeoutMs` outside 1 to 15 000, or a text key
that is not a bare key. `list` and `invoke` keep the ordinary gate.

Both schemas belong to the host plugin. The host validates the input before
the call and the output after it, and refuses a key the schema does not name at
any depth: a field nobody declared is a field an addon could use to hand over
something nobody consented to. So a point's schema names every key it carries.
A record, a catchall, `z.unknown()` or `z.any()` anywhere inside it, an array of
them included, is refused at `define`, although an action's input may hold one:
each of them carries keys nobody named. Both values are copied as JSON on the way
through, so no function, object reference, request or person crosses a point.

`list` returns the contributions serving at the point, in addon id order, each
with the addon's id and its `titleKey` and `descriptionKey` qualified into the
addon's namespace as `plugin-<addon>:<key>`. `invoke` throws for a mistake of the
host plugin's own - a point its manifest does not declare or it has not defined,
an input its own schema refuses - and rejects with the reason of a `signal` the
host plugin aborted itself. Everything the addon does is answered in the result,
so a rotation that loses one source goes on with the others:

<!-- prettier-ignore -->
| Reason | When |
| --- | --- |
| `not-serving` | The addon is not installed, not loaded, switched off, or has no contribution here. |
| `timed-out` | The handler did not answer in time. Its `signal` is aborted and a late answer is dropped. |
| `failed` | The handler threw. Its class and frames are logged with the addon's id, never its message. |
| `output-invalid` | The answer does not meet the output schema, has no JSON form, or is too long. It is never handed over. |

An answer longer than `EXTENSION_MAX_OUTPUT_LENGTH`, 1 048 576 characters as
JSON, is refused before it is parsed. The time a point gives bounds only how
long the host waits for the handler's promise. The handler runs on the host's
one thread, as all plugin code does, so work it does synchronously, and a
`toJSON` or getter in its answer, is not stopped by the time: a handler that
loops stalls the whole instance. Do the slow part of a contribution
asynchronously and honour the `signal`.

A contribution runs with the addon's own host object, under the permissions the
board consented to for the addon, and with no person behind it: an extension
point is a call between two plugins. Its `context` names the host plugin, the
point, the point's version, a request id for the logs, the time, and the
`signal`. Accept input fields you do not know: a host plugin may add an optional
field to a point without raising its version.

What a contribution reads through `host.addressBook` while it answers also
leaves out every person whose objection to the host plugin's processing the
board granted ([ADR 0035](adr/0035-a-plugin-s-processing-and-objecting-to-it.md)),
so read for the answer inside the handler rather than handing over a copy read
outside it.

### When a contribution serves

A contribution serves while the addon and its host plugin are both installed,
consented to, loaded and switched on, the host plugin declares the point at the
version the addon names, the point accepts what the addon hands over, and the
addon has contributed. Whether the point exists at that version and accepts
those categories is read from the two manifests before the addon's code runs,
and an addon that fails either is not loaded at all. Whether it has contributed
is known only once its code has run and called `contribute`.

An addon exists for its host plugin. While the host plugin does not serve, the
addon does not either: when the host plugin is switched off, removed or refused,
every addon of it stops at once, its routes answer as though it were not
installed, its host object refuses, and the admin screen says
`extension-host-missing`. The addon stays installed and consented to, so putting
the host plugin back brings it back with the restart that does, without a
consent of its own. An addon can be installed before its host plugin and waits
with the same finding.

Raise a point's version when an addon written for the last one would break: a
new required field in the output, a field removed from the input, a narrower
type. An addon written for another version is refused with
`extension-version-unsupported`, and a host plugin serves one version of each
point at a time.

The points a plugin offers and the ones it extends are compared at every boot
with what the board consented to, as its permissions are. A republished host
plugin that adds a point or lets one accept more, and a republished addon that
extends another point or hands over more, are refused with
`extensions-widened` until the board installs them again.

There is no sandbox ([ADR 0003](adr/0003-plugin-loading-and-module-resolution.md)).
An addon runs in the instance's process with its privileges, as every plugin
does, so "the addon never receives the host plugin's permissions" is a promise
the host objects keep, not one hostile code could not break. Catalog curation is
what keeps hostile code out, for an addon exactly as for any plugin.

### Feature detection

```ts
if (host.extensions === undefined) {
  // This instance has no extension points. Offer none, and contribute nothing.
}
```

An instance too old to have them never offers an addon at all: the catalog
lists one only in version 2 of its index, which such an instance does not read.

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
reasons are those of the theme screen, and these five of its own:
`checksum-mismatch` and `malformed-digest` (422) for the digest you stated,
`package-too-large` (422) above the 8 MiB a theme package may have,
`theme-not-from-plugin` (409) for a theme your plugin did not install, and
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
  "version": 2,
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
      "processing": {
        "purpose": { "sv": "...", "en": "..." },
        "legalBasis": "legitimateInterest",
        "legitimateInterest": { "sv": "...", "en": "..." },
        "retention": { "sv": "...", "en": "..." },
        "dataSubjects": ["members", "residents"],
      },
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
`actions`, for a connector `oauthProtectedResource`, for an AI package `ai`, and
in an index of version 2 `processing`, `recipients`, for a plugin that devices
reach `deviceRoutes`, and for a plugin with extension points or one that
extends them, `extensionPoints` and `extends`. An entry's `recipients` are held to the
manifest's own rule: a category a recipient receives is among the entry's
`personalData`, and an index with one that is not is refused. A theme entry
adds the token `contract` range and the theme it `extends`, and names no
package: a theme is read out of its archive and never installed with npm. The
installed package is authoritative for both kinds. The catalog's check, below,
refuses an entry that disagrees with its package, except for `recipients`
([ADR 0037](adr/0037-declared-outbound-hosts-and-secret-settings.md)),
`extensionPoints` and `extends`
([ADR 0030](adr/0030-plugins-that-extend-plugins.md)), which it does not
compare yet. An
instance does not compare entry and package either: its installer checks that
the archive is the package name, version and id the board consented to, and at
boot the package's manifest is held to the consent snapshot. For `recipients`
that is the check that applies today: a package that adds a declared recipient,
moves one to another origin, or adds a personal-data category to one that the
board has not consented to does not load and is reported as
`recipients-widened`. For `extensionPoints` and `extends` the same check
applies: a package whose extension declarations exceed the consent snapshot does
not load and is reported as `extensions-widened`. The index also holds an addon
against a plugin it extends where it lists both, and refuses it when that
plugin's entry declares no such point, declares it at another version, or does
not accept a personal-data category the addon's entry hands over. The check
compares the two entries and nothing else: the packages installed may declare
otherwise, and the plugin may not be installed or running at all. The loader
reads the installed manifests and refuses such an addon when the instance
starts (`extension-host-missing`, `extension-point-unknown`,
`extension-version-unsupported`, `extension-personal-data-refused`).

A refusal of the index that holds an addon against another entry - those three,
and the rules on the website and the address book between an addon and the
plugins it is joined to - carries, beside the curator's English line, the code
of the loader's finding of the same name and the values its sentence needs
(`CATALOG_REFUSALS`, in `diagnostics` of what `parseCatalogIndex` returns). The
command-line tool prints that sentence, from the application's translations,
above the line. A problem with one entry's own field is the line alone.

`deprecated` is how a curator withdraws an entry without delisting it. Both
screens mark the entry as no longer maintained, and an instance refuses to
install it anew with the reason `entry-deprecated` (409). An instance that
already has the plugin or theme can still reinstall it and take its updates,
so a board is never left unable to repair something it already runs.

A plugin entry's `id` stays with its `packageName`. The index does not hold a
later revision to that, but an instance keeps a plugin's settings, records, job
queues and device tokens under its id, so it refuses to install an entry naming another
package than the one it has installed under that id, with the reason
`plugin-package-changed` (409), until the board removes the installed one.

A curator therefore does not rename a package under an id that instances run.
An entry that names a new `packageName` under an existing `id` strands every
instance that has the plugin installed: its board can no longer install or
update it from the catalog until they remove it, and removing it deletes the
plugin's settings, its configuration records and the device tokens it issued.
The new package then installs with none. Give a package that has to move a new
`id` instead, and deprecate the old entry, so that instances keep what they
have while their boards move over by hand.

An `id` appears once in the index, whatever the entry's type. An index that
lists one twice is refused as a whole, as is an index carrying any entry the
instance cannot read: a board installing from an index that silently lost an
entry could not tell it from one delisted on purpose. Every object in the index
is read strictly, so a field this version of the index does not define is
refused rather than ignored: a misspelled field of the declaration would
otherwise be replaced by its default before the consent screen showed it. A new
field is a new index `version`. A point's entry in the index adds a `title` and
a `description` in Swedish and English, written by the curator as the entry's
`name` is, because an addon's consent screen has to name the point before the
host plugin's locale files are on the instance.

An instance reads index versions 1 and 2 (`CATALOG_INDEX_VERSIONS`). Version 2
adds five fields to a plugin entry, `processing`, `recipients`, `deviceRoutes`,
`extensionPoints` and `extends`, and changes nothing else. `processing` is required of an entry
that declares personal data and refused from one that declares none, as the
manifest does, and an entry that reads the address book and declares no
personal data is refused. An entry whose `deviceRoutes` the manifest would
refuse - one beside a register permission, two that overlap, one over
`oauthProtectedResource` - is refused in the index as well, so it is never
offered for consent. Version 1 is the index as it stood before, and refuses any
of the five, even empty, like any field it does not define. A catalog that
lists entries using version 2 keeps serving version 1, without them, to
instances that read nothing newer, and serves version 2 beside it
([ADR 0030](adr/0030-plugins-that-extend-plugins.md)). The address built into
an instance is that of version 2, `catalog-v2.json`; the instance never reads
`catalog.json`. A new value in an existing list, such as a personal-data
category, is not a new version: an index whose entries do not use it reads as it
did. An instance too old to know the value refuses the whole index if any entry
uses it, whatever the version says.
`@openbrf/plugin-sdk` exports the schema and `parseCatalogIndex`, so a
catalog's own check reads the index exactly as an instance does.

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
  resource, device routes, whether it is an AI package, and the licence it reads with its
  release date, and, once the check compares them (ADR 0037), recipients (each
  one's id, origin, purpose and categories, the board reading the entry's before
  anything is downloaded); for a theme the name, version, contract and parent,
  the parent being the built-in theme or a theme in the same index;
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

<!-- prettier-ignore -->
| Claim | Value |
| --- | --- |
| `issuer` | `https://token.actions.githubusercontent.com` |
| `sourceRepositoryURI` | `https://github.com/<owner>/<repo>` |
| `sourceRepositoryRef` | `refs/tags/v<version>` |
| `buildSignerURI` | `https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/v<version>` |
| `buildConfigURI` | the same as `buildSignerURI` |
| `runnerEnvironment` | `github-hosted` |

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
consents to the licence before anything is downloaded. An entry in a version 2
index also repeats the plugin's declared recipients as `recipients`, so the
board reads them before anything is downloaded. The catalog's check does not
yet compare an entry's `recipients` with the package.

## Operator configuration

<!-- prettier-ignore -->
| Variable | Default | Effect |
| --- | --- | --- |
| `OPENBRF_PLUGINS_ENABLED` | `true` | When false, nothing is loaded or installable. |
| `OPENBRF_CATALOG_URL` | `https://raw.githubusercontent.com/openbrf/catalog/main/catalog-v2.json` | Where the catalog is read from. Leave empty for the curated index. |
| `OPENBRF_CATALOG_TOKEN` | unset | Bearer token for an index that requires one, sent to it and to artifacts on its own origin only. |
| `OPENBRF_UNCURATED_PLUGINS_ENABLED` | `false` | Required to point `OPENBRF_CATALOG_URL` anywhere but the curated index. |
| `OPENBRF_PLUGINS_REINSTALL_ON_BOOT` | `false` | Reinstall at boot when the data volume does not carry what the database says is installed. |
| `OPENBRF_ALLOW_PRIVATE_HOSTS` | `false` | Lets `host.recipients.fetch` reach a declared origin on a private network, as it does the SMS gateway and the mail servers. |

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

<!-- prettier-ignore -->
| Reason | Meaning |
| --- | --- |
| `download-budget-spent` | The run's downloads used their whole time before this one began. |
| `download-timed-out` | The archive did not finish downloading in the time it was given. |
| `source-not-allowed` | The archive's address, or a redirect, is not a source the instance reads. |
| `source-unreachable` | The release host could not be reached, or redirected nowhere usable. |
| `source-answered-error` | The release host answered with an HTTP error status. |
| `archive-too-large` | The archive is larger than an instance accepts. |
| `checksum-malformed` | The catalog states a checksum that is not a sha512 digest. |
| `checksum-mismatch` | The downloaded bytes do not hash to the checksum the catalog states. |
| `download-failed` | The download failed for a reason with no code of its own. |
| `archive-unreadable` | The archive could not be unpacked to read its package.json. |
| `archive-not-a-plugin` | The archive's package.json is not an installable plugin package. |
| `archive-package-mismatch` | The archive holds another package or version than the one consented to. |
| `npm-install-failed` | npm could not install the verified archives. |
| `package-not-installed` | npm finished without installing a consented archive as a package. |
| `unconsented-packages` | npm installed packages no archive was consented for. |
| `installation-claim-lost` | Another run took the installation over while this one was building it. |
| `build-failed` | Building the installation failed for a reason with no code of its own. |

## When a plugin does not load

A malformed or failing plugin is skipped and reported, never fatal. A broken
plugin must not be able to take the housing cooperative's statutory registers -
the member register and the apartment register - offline. The admin screen
lists everything on the data volume that is not running and why:

<!-- prettier-ignore -->
| Reason | Meaning |
| --- | --- |
| `manifest-invalid` | The `openbrf` field failed validation. |
| `api-version-unsupported` | Built against a contract version this instance does not implement. |
| `entry-missing` | A declared entry file is not in the package. |
| `entry-invalid` | The server bundle does not export `createPlugin`. |
| `module-invalid` | `createPlugin` returned no NestJS dynamic module. |
| `module-refused` | Its module declares behaviour a plugin may not register. |
| `module-failed` | Its module could not be built into the application. |
| `module-identity` | The package carries its own copy of a host package it must share. |
| `permissions-widened` | It asks for more than was consented to. |
| `personal-data-widened` | It handles personal data, or keeps records, beyond what was consented. |
| `actions-widened` | It declares an action the board has not consented to. |
| `action-refused` | An action it declares could not be registered. |
| `ai-changed` | Whether it is an AI package is not what the board consented to. |
| `licence-widened` | It reads another licence, with another key, or for another service. |
| `licence-issuer-changed` | It names another issuer, or drops a key the board consented to. |
| `block-refused` | It registered a website block its manifest does not declare. |
| `forbidden-injection` | A provider, controller or enhancer reaches for a core service. |
| `oauth-resource-conflict` | Another installed plugin already serves the OAuth protected resource. |
| `recipients-widened` | It declares a recipient the board has not consented to. |
| `device-routes-widened` | It declares or moves a device route the board has not consented to. |
| `audit-rate-exceeded` | It wrote more audit entries with no request than `PLUGIN_AUDIT_LIMITS.perMinute` allows, and was stopped. |
| `extension-host-missing` | A plugin it extends is not installed, not loaded, or switched off. The detail names it. |
| `extension-point-unknown` | The plugin it extends declares no such point. |
| `extension-version-unsupported` | The point is at another major version than the one the addon was written for. |
| `extension-personal-data-refused` | It hands over a category of personal data the point does not accept. |
| `extension-permission-refused` | It or the plugin it extends reads the address book or the finances, or proposes imports, and the other puts website blocks. |
| `extension-host-personal-data-refused` | It puts website blocks, and the plugin it extends handles personal data. |
| `extension-group-refused` | The plugins joined to it by extensions hold one with website blocks and one that reads the address book or the finances, proposes imports or declares personal data about the members. |
| `extension-device-group-refused` | The plugins joined to it by extensions hold one with device routes and one that reads contact details or the finances, or proposes imports. |
| `extensions-widened` | It declares a point, an extension or a category the board has not consented to. |
| `extension-refused` | A definition or contribution it registered could not be accepted. |
| `not-consented` | On the volume with no record of consent, or not the consented package. |
| `disabled` | Switched off in the admin interface. |
| `load-failed` | It threw while being loaded. |
| `not-on-volume` | Recorded as installed but not present. |

Seven of these need an answer rather than a restart:

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
- `device-routes-widened` is the same gate again, for the device routes,
  compared by id and path: a version that adds a route or moves one to another
  path reaches somewhere the board never saw. Reinstalling shows the new routes
  for consent. The finding names the route ids.
- `extensions-widened` is the same gate for extension points: a host plugin
  that now offers a point it did not, or lets one accept a category it did not,
  and an addon that now extends another point or hands over more, reach beyond
  what the board saw. Reinstalling shows the new points and extensions for
  consent.
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

A `manifest-invalid` finding whose package broke a rule that holds two of its
declarations against each other - a device route beside a permission that reads
the register or proposes an import, a website block beside one, a device route that overlaps the OAuth
protected resource - carries the rule's code in `detail.rules`
(`PLUGIN_MANIFEST_RULES`), and the admin screen words it in its own language.
`detail.issues` holds the schema's English lines for every other problem, and
`detail.specifics` the English line of each broken rule, naming the route or the
resource involved; the admin screen does not show it, and the boot log does.

The set is exported as `PLUGIN_FINDING_REASONS` from `@openbrf/plugin-sdk`. A
finding carries one of these codes and a `detail` object holding the values its
sentence needs - a version number, a file name, the categories a republished
package added - and never a sentence of its own: the admin screen is Swedish by
default while the server is English throughout, so the wording belongs to the
interface. English prose about a refusal goes to the server's log, where the
person debugging the package is reading.
