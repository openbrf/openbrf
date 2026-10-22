# ADR 0030: Plugins that extend plugins

Date: 2026-10-19

## Status

Accepted. Extends [ADR 0003](0003-plugin-loading-and-module-resolution.md) and
[ADR 0008](0008-action-registry.md); both stand unchanged.

## Context

A plugin is an isolated module. It has its own routes under
`/api/plugin/<id>/`, its own host object and its own consent, and it cannot see
another plugin. The one mechanism that crosses between plugins is the action
registry (ADR 0008), and it answers a different question: an action is
something a **person** can be asked to do, dispatched as that person under one
core capability. It has no way to say "this plugin offers a slot, and that
plugin fills it".

Digital signage is the first module that needs one. It shows news, the event
calendar and free/busy times on a screen in the building, and the board wants
others, Apteo included, to be able to add what a screen shows: the people
living in the entrance the screen hangs in, the weather, the next bus. Those
are not features of the signage plugin. They are separate pieces of software
with separate reasons to exist and, above all, separate access to the
association's data: the one that shows residents reads the register, and the
one that shows the weather reads nothing at all.

Two shapes were possible. The signage plugin could load other code into
itself, which would give every addon the signage plugin's permissions and the
signage plugin every addon's; the board would consent once to something whose
reach grows with every addon installed later. Or each addon could be a plugin
of its own, installed, consented to and switched on by itself, and the host
could carry data between them. This ADR takes the second.

Nothing here is specific to signage. A booking plugin that lets others add
payment methods, or a report plugin that lets others add sections, has the
same need.

## Decision

### Words

- An **extension point** (utökningspunkt) is a named slot a plugin declares and
  offers to other plugins: for signage, `source`, a content source for the
  screen's rotation. The plugin that declares it is the point's **host
  plugin**.
- An **addon** (utökning) is a plugin that extends another plugin at one of its
  extension points. It is a plugin in every other respect: installed from the
  catalog, consented to, switched on and off, and removed by itself.
- A **contribution** is what an addon registers at one extension point: a title
  and a handler.

The three terms are in GLOSSARY.md.

### The host plugin declares the point

```jsonc
{
  "openbrf": {
    "id": "signage",
    "personalData": ["name", "apartment", "photograph", "freeText"],
    "extensionPoints": [
      { "id": "source", "version": 1, "personalData": ["name", "apartment"] },
    ],
  },
}
```

| Field          | Required | Meaning                                                                                                                                                           |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | yes      | Lowercase letters, digits and single hyphens, 2 to 32 characters, unique within the plugin.                                                                       |
| `version`      | yes      | An integer from 1. The point's major version: raised when a change to the point's schemas would break an addon written for the last one.                          |
| `personalData` | no       | The categories of personal data a contribution may hand the host plugin through this point. Empty by default. Must be among the host plugin's own `personalData`. |

A plugin declares at most eight points. `personalData` uses the categories a
plugin's own `personalData` may name (`PLUGIN_PERSONAL_DATA_CATEGORIES`, listed in
docs/plugin-contract.md). It is what the
board consents to when it installs the host plugin: "addons may hand it names
and apartments". A host plugin that wants more later is a republished version
that has widened its reach, and it is refused until the board consents again.

A plugin's own `personalData` is the categories it handles (docs/plugin-contract.md),
and what an addon hands it is handled by it as much as what it reads itself. So
the categories a point accepts are among the host plugin's own, and a host
plugin whose point accepts names is in the record of processing activities with
a processing declaration of its own
([ADR 0035](0035-a-plugin-s-processing-and-objecting-to-it.md)). Declaring a
category grants nothing: reading the register still takes an address-book
permission, which a plugin with a device route cannot hold.

Two combinations fail the manifest schema, because each would open a path from
the register to a place the core keeps it out of:

- A plugin that asks for `site:blocks`, the permission a plugin's website blocks
  need, declares points with no personal data at all. What a website block
  renders is published to the street, and `site:blocks` already excludes the
  address-book permissions so that there is no path from the register to the
  website ([ADR 0006](0006-the-page-block-model.md)). An extension point that
  accepted names would be that path through a second plugin.
- A plugin that declares device routes
  ([ADR 0031](0031-a-device-token-for-a-plugin-s-own-routes.md)) declares points
  that accept neither `email` nor `phone`. A device is a screen on a wall, and
  contact details have no business there.

### The addon declares what it extends

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

| Field          | Required | Meaning                                                                                              |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `plugin`       | yes      | The id of the host plugin.                                                                           |
| `point`        | yes      | The id of the extension point.                                                                       |
| `version`      | yes      | The point's major version the addon was written against.                                             |
| `personalData` | no       | The categories the contribution hands the host plugin. Must be among the addon's own `personalData`. |

An addon extends at most eight points, names each pair of plugin and point once,
and never names itself. A plugin that declares `extends` declares no
`extensionPoints`: an addon cannot be extended in turn. One level is what the
first module needs, and a chain would make the question "what can reach this
screen" one the board could not answer from two consent screens.

The addon's consent screen states what it extends and what it hands over, from
the catalog entry and before anything is downloaded: "extends Digital signage at
Source, and hands it names and apartments". It also states the addon's own
permissions and personal data, as for any plugin. The addon never receives the
host plugin's permissions, and the host plugin never receives the addon's.

### The host carries the call

The host object gains `host.extensions`. The host plugin uses two halves of it
and the addon one.

```ts
export interface PluginExtensions {
  /** Host plugin: the schemas of a point its manifest declares. */
  define<Input, Output>(
    point: string,
    definition: ExtensionPointDefinition<Input, Output>,
  ): void;

  /** Host plugin: the contributions to one of its points that are serving now. */
  list(point: string): Promise<readonly ExtensionContributionSummary[]>;

  /** Host plugin: calls one addon's contribution. */
  invoke<Output>(
    point: string,
    addon: string,
    input: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<ExtensionResult<Output>>;

  /** Addon: the handler for a point its manifest extends. */
  contribute<Input, Output>(
    target: { plugin: string; point: string },
    contribution: ExtensionContributionDefinition<Input, Output>,
  ): void;
}

export interface ExtensionPointDefinition<Input, Output> {
  readonly input: StandardSchemaV1<unknown, Input>;
  readonly output: StandardSchemaV1<unknown, Output>;
  /** How long a contribution may take. 5 000 ms by default, at most 15 000. */
  readonly timeoutMs?: number;
}

export interface ExtensionContributionDefinition<Input, Output> {
  /** Bare keys in the addon's own namespace, as an action's are. */
  readonly titleKey: string;
  readonly descriptionKey?: string;
  readonly handler: (
    input: Input,
    context: ExtensionContext,
  ) => Promise<Output>;
}

export interface ExtensionContributionSummary {
  readonly addon: string;
  /** Qualified into the addon's namespace, `plugin-<addon>:<key>`. */
  readonly titleKey: string;
  readonly descriptionKey: string | null;
}

export interface ExtensionContext {
  readonly hostPlugin: string;
  readonly point: string;
  readonly version: number;
  readonly requestId: string;
  readonly now: Date;
  readonly signal: AbortSignal;
}

export type ExtensionResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | {
      readonly ok: false;
      readonly reason:
        "not-serving" | "timed-out" | "failed" | "output-invalid";
    };
```

`define` and `contribute` are declarations, so they are callable from the module
factory and buffered until the application exists, as `host.actions.register`
is. `list` and `invoke` keep the ordinary gate and work from `onModuleInit`
onwards. An addon contributes once to each point it extends.

The host plugin owns the shape. It defines both schemas, and the host validates
the input before the call and the output after it. Every object in either schema
refuses unknown keys at every depth, and the schemas are built with the host's
own zod, for the reasons ADR 0008 gives for an action's: a field the schema does
not name is a field an addon could use to hand over something nobody consented
to, and a schema from a second copy of zod cannot be read. A definition that
breaks either rule, a point or a target the manifest does not declare, or a
second contribution to the same point is refused, and the plugin that made it
stops serving with `extension-refused`.

**What `invoke` throws and what it returns.** A mistake of the host plugin's
own throws: a point it never declared, or an input its own schema refuses. What
the addon does is answered in the result and never thrown, because a rotation
that loses one source should go on with the others:

| Reason           | When                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `not-serving`    | The addon is not installed, not loaded, switched off, or has no contribution here.        |
| `timed-out`      | The handler did not answer in time. Its `signal` is aborted and a late answer is dropped. |
| `failed`         | The handler threw. What it threw is logged with the addon's id and never handed over.     |
| `output-invalid` | The answer does not meet the output schema. It is logged and never handed over.           |

**Only data crosses.** The input and the output are copied as JSON values on
the way through. No function, no object reference, no request and no person
crosses a point, so a host plugin cannot hand an addon something to call back
into and an addon cannot hand the host plugin its host object. A contribution
runs with the addon's own host object, under the permissions the board
consented to for the addon, and with no caller: an extension point is a
plugin-to-plugin call, not a person's request, and the actions an addon may
dispatch need a request it does not have here.

### When a contribution is serving

A contribution is serving while all of these hold, and `list` returns exactly
the ones that do:

- the addon and its host plugin are both installed, consented to, loaded and
  switched on;
- the host plugin declares the point at the major version the addon names;
- what the addon hands over is among what the point accepts;
- the addon has registered its contribution.

An addon is a plugin that exists for its host. While a plugin it extends is not
serving, the addon does not serve either: its routes answer as though it were
not installed and its host object refuses, the same as when the board switches
it off. Switching the host plugin back on brings the addon back with it,
without a restart when the host plugin was only switched off.

The admin screen says why an addon is not serving. The new findings join
`PLUGIN_FINDING_REASONS`:

| Reason                            | Meaning                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `extension-host-missing`          | A plugin it extends is not installed, not loaded, or switched off. The detail names it. |
| `extension-point-unknown`         | The plugin it extends declares no such point.                                           |
| `extension-version-unsupported`   | The point is at another major version than the one the addon was written for.           |
| `extension-personal-data-refused` | It hands over a category of personal data the point does not accept.                    |
| `extensions-widened`              | It declares a point, an extension or a category the board has not consented to.         |
| `extension-refused`               | A definition or contribution it registered could not be accepted.                       |

`extensions-widened` is the gate `permissions-widened` and `actions-widened`
are, compared by the whole declaration: a republished host plugin that adds a
point or lets a point accept more, and a republished addon that extends a new
point or hands over more, both need the board's consent again.

An addon can be installed before its host plugin, and it carries
`extension-host-missing` until the host plugin is there. Removing the host
plugin leaves its addons installed and not serving, so that putting it back
does not mean consenting to each addon again.

### Versions

A host plugin raises a point's version when an addon written for the old one
would break: a new required field in the output, a field removed from the
input, a narrower type. Adding an optional field to the output, or a field to
the input that an addon may ignore, keeps the version, which is why an addon's
handler must accept input fields it does not know. An addon written for
another version carries `extension-version-unsupported` and the host plugin's
rotation carries on without it. A host plugin serves one version of each point
at a time.

### The catalog

The consent screens render from the catalog entry, so the entry carries the
declarations: a plugin entry gains `extensionPoints` and `extends`, with the
fields above. A point's entry also carries a `title` and a `description` in
Swedish and English, written by whoever curates the catalog as the entry's own
`name` is, because the addon's consent screen has to name the point before the
host plugin's locale files exist on the instance. The catalog check compares
both fields with the package, as it compares `actions`.

These fields, the device routes of ADR 0031 and the processing declaration of
[ADR 0035](0035-a-plugin-s-processing-and-objecting-to-it.md) are not in
version 1 of the index, and the index is read strictly (ADR 0020), so they make
**index version 2**. The permissions of
[ADR 0032](0032-read-only-content-for-plugins.md) are new values in an existing
list, which alone would not change the version (docs/plugin-contract.md), but an
instance that does not know them refuses the whole index when an entry uses
them, so they come with version 2 as well. An instance that implements them
reads both versions. The catalog keeps serving version 1 at its current
address for instances that have not upgraded, listing only the entries that use
none of these fields and none of these permissions, and serves version 2 beside
it; an instance that reads version 2 has the version 2 address built in
(`catalog-v2.json`, in `CURATED_CATALOG_URL`), and does not read version 1.

## Consequences

- Each addon is a separate consent, a separate entry in the record of
  processing activities and a separate switch. The board can say yes to the
  weather and no to the residents, and can switch the residents off on its own.
- The host plugin receives personal data it did not read itself. Its own
  consent states what its points accept, and an addon's states what it hands
  over and to whom, so both halves of the flow are on a screen the board has
  read, and each has its own row in the record of processing activities. Where
  the host plugin then sends it is the host plugin's declaration, as it is for
  data it reads itself.
- There is still no sandbox (ADR 0003). An addon runs in the instance's process
  with its privileges, and so does the host plugin, so "the addon never
  receives the host plugin's permissions" is a promise about the host objects,
  which the SDK keeps, and not about what hostile code could do. Catalog
  curation is what keeps hostile code out, for an addon exactly as for any
  plugin.
- An addon that extends a paid plugin is useless without it. The catalog entry
  says which plugin it extends, so a board sees that before installing it.
- `host.extensions` is added after this contract version shipped, so a plugin
  built against a newer host must feature-detect it, as it does `host.actions`.
  An older instance never offers an addon at all, because the version 1 index
  cannot list one.
- The contract test that walks an action's output for undeclared personal data
  (ADR 0008) does the same for a point's output schema against the categories
  the point accepts. It proves as little as it does there: a declaration is
  written by hand, and review is what stands behind it.

## Rejected alternatives

- **Addons as code loaded inside the host plugin.** One consent for a reach that
  grows with every addon installed later, and every addon holding the host
  plugin's permissions.
- **Extension points as actions.** An action is a person's request under one
  core capability. A contribution has no person behind it, and making one up
  would put a capability check where none is meant.
- **Events or subscriptions between plugins.** Nothing the first module needs
  is an event, and a call with a schema at both ends is something the host can
  validate, time out and refuse.

## Revisit triggers

- **A host plugin needs to serve two major versions of a point at once**, to
  give addons time to move.
- **An addon needs a person**: a contribution that answers differently for the
  board than for a resident would need the caller, and that would bring the
  action registry's rules with it.
- **A second level of extension**, an addon to an addon.
- **A JS sandbox becomes viable** (ADR 0003): the separation between an addon
  and its host plugin would then be enforceable, not only declared.
