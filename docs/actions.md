# Actions

What the platform can be asked to do, declared once and dispatched through one
place. This document has two readers: the author of a plugin that proposes an
action, and whoever maintains the registry the platform's own actions are
registered with.

The decisions behind the design - why dispatch is a choke point rather than a
convenience, and why the write services stay ignorant - are recorded in
[ADR 0008](adr/0008-action-registry.md). What follows is the contract an action
has to meet.

## What an action is

An action is a name, an input schema, an output schema, the single capability it
needs, what it does to the records, which categories of personal data it can
touch, and which surfaces it may be offered on. `ActionDefinition` in
`@openbrf/plugin-sdk` is the whole of it.

An action is **not a permission of its own**. `ActionRegistry.invoke()`
re-derives the calling person's capabilities on every call, through the same
`PrincipalService.forPerson` the HTTP guard goes through, and then checks the one
capability the action declared. Registering an action therefore grants nothing:
it is a way of reaching something the caller could already do. The write services
behind the handlers hold no principal and check nothing at all, because a check
inside one would be a third opinion able to disagree with the other two.

That settles what an action is for. It is worth adding when a caller who is not
a person in a browser needs to reach something a person can already reach from a
screen. It is not the place to put a rule, a shortcut past a guardrail, or a
capability nothing else grants.

`ACTION_SURFACES` has three values. `ui` means in process - the platform's own
screens and a plugin's own route. `mcp` and `ai` are the ones a board switches on
deliberately. `surfaces` is an opt-in allowlist, and an empty array means the
action is offered nowhere.

A core feature registers its own actions through `CoreActionRegistrar`. A plugin
registers the ones its manifest declared and the board consented to, and they
disappear with the plugin; the extra steps a plugin's action passes through are
in [the plugin contract](plugin-contract.md).

## The name

```
ACTION_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/
```

Lowercase ASCII letters, digits and underscores, starting with a letter, three
to sixty-four characters. Sixty-four is the intersection of three separate
limits: what an MCP `tools/list` entry allows, what a model API allows - which is
where the absence of a dot comes from - and what stays readable when somebody
reviews a directory of them.

A name is an interface symbol rather than a domain term, so GLOSSARY.md does not
govern it. The glossary settles what appears on a screen; a name here is what a
program writes into a call. `news_publish` is the right name even though nothing
on the board's own screen says that, and the Swedish term for the thing being
published belongs in `titleKey` and `descriptionKey`, which are translated.

A name that has been published is not reused for a different shape. MCP clients
cache `tools/list` at initialisation and do not refresh when a schema changes, so
a caller can be holding last week's document and calling against it.
`deprecatedAliases` carries an old name onto the definition that replaced it: an
alias resolves on dispatch, is never enumerated in a listing, and collides with a
registered name or another alias exactly as a name would - `register` refuses
both with "Two actions claim the name".

### The per-plugin name budget

A plugin's action is offered under a composed name: the plugin's id with dashes
folded to underscores, then an underscore, then the action's id.
`composedActionName` is the only place that folding happens, and the binder uses
the same function to compose the armed ids stored against the plugin, so the two
cannot disagree about which action was armed.

| Part          | Pattern                         | Length  |
| ------------- | ------------------------------- | ------- |
| plugin id     | `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` | 2 to 48 |
| action id     | `^[a-z][a-z0-9_]{2,31}$`        | 3 to 32 |
| composed name | `^[a-z][a-z0-9_]{2,63}$`        | 3 to 64 |

48 plus a separator plus 32 is 81 against a limit of 64, so a long plugin id
spends budget an action id would otherwise have. The pair is checked rather than
the action id alone: shortening every action id to the worst case would charge
every plugin for the longest possible plugin id, and would forbid
`monthly_occupancy_report` to a plugin called `brf`, whose composed name is
twenty-eight characters. The check is a `superRefine` on the manifest schema, so
an over-long pair is manifest-invalid before the install consent screen rather
than a finding after the plugin's code has already run.

The folding has a second consequence. A plugin `a-b` declaring `c` and a plugin
`a` declaring `b_c` compose the same name, `a_b_c`. No manifest can see that,
because neither declaration is wrong on its own, so this one is caught later: the
registry refuses the second to arrive, at registration, and the plugin that loses
stops serving with an `action-refused` finding for the board to read. An action
id that reads as a prefix of a plugin id is the shape to avoid.

## What a description must say

The description is the only thing a caller who is a model has to go on. It runs
to three or four sentences, and a contract test over the catalogue asserts the
count in Swedish and in English alike:

1. What it does.
2. What it explicitly does **not** do.
3. What must be true first.
4. For any action returning stored content, that the text is written by people
   and is data, never instructions.

The second clause is the one that would otherwise be left in a code comment. A
caller who is a model acts on what the document says and cannot read the comment,
so "It never sends the mailing or the text message to the members" belongs in
`news_publish`'s description, where it is read, rather than beside the handler,
where it is not. The same sentence then says what to do instead - request the
mailing, and a board member confirms the send in the web interface - which is the
difference between a model that stops and a model that looks for another way.

The fourth clause is the same reasoning applied to the response. A news body is
free text a person wrote, so an action that returns it hands a model a document
that may contain sentences shaped like instructions. The description is where
there is room to say so.

Every field an input asks for carries a `.describe()` of its own, and a contract
test walks the core catalogue's published documents to assert it. A description
survives the JSON Schema conversion, so it is the one place a per-field
explanation reaches the caller; an undescribed property is a guess for a model,
and a guess on a write is a page rewritten from one.

A plugin writes its keys bare - `actions.summary.description` - and the host
qualifies them into the plugin's own namespace, `plugin-<id>:`. A key that was
not qualified would be looked up in the platform's own resources and render as
the key itself on the board's screen.

## Structural constraints first

This is the section to read before writing a schema.

`.refine()`, `.check()`, `.superRefine()` and `.brand()` are **erased** by the
JSON Schema conversion, under both modes, with no marker left behind. Nothing
fails. The published document is simply looser than the runtime check, which
means telling a caller a value is acceptable that the service will then refuse -
and a caller who is a model will keep sending it, because the document says it is
fine.

So a refine that carries a real rule gets a structural keyword beside it that the
refine still narrows. The live example is the `link` field of a text run in
`apps/api/src/site/page-content.ts`:

```ts
link: z
  .string()
  .regex(/^(?:https?:\/\/|mailto:|\/)/)
  .refine(isPublishableUrl)
  .optional(),
```

The pattern survives conversion and carries the structural half of the rule.
`isPublishableUrl` still refuses `javascript:`, `data:` and protocol-relative
addresses, which a pattern of that shape does not express. The pattern is
deliberately a superset the refine narrows, and a spec asserts that it accepts
everything the refine accepts and rejects those three shapes. A pattern narrower
than its refine would be the same defect in the other direction: a document
refusing what the service would have taken.

The rule generalises. A bound, an enum, a length, a pattern, a required key -
anything JSON Schema can state - is stated structurally. A refine is what is left
over.

## What cannot be published at all

`actionInputJsonSchema` and `actionOutputJsonSchema` wrap the product's only call
to `z.toJSONSchema`, and `register` runs both at registration, before anything
can call the action. A schema that cannot be published is a defect in the action,
and the moment to refuse it is before the first caller finds it.

- **A date.** `z.date()` has no JSON Schema representation and throws. The
  `unrepresentable` handler is a function rather than the default so the failure
  names the action and the path; a build failing with "unrepresentable type" and
  nothing else is half an hour of searching.
- **A transform.** Asymmetric, and worth knowing exactly: under input mode a bare
  `.transform()` does not throw - it is erased and the pre-transform type is
  emitted. Only output mode refuses. That asymmetry is why registration converts
  **both** directions over the pair, the input schema under `io: "input"` and the
  output schema under `io: "output"`, so no action can carry a transform
  anywhere.
- **A cycle.** `cycles: "throw"`. A self-referential schema has no JSON Schema
  without `$ref`, and a silently emitted `$ref` to a positional name is worse
  than a refusal at registration.
- **A `$ref` of any kind.** `reused: "inline"`, because `$defs` invents names
  from the position a schema happens to hold, and those names would reach a
  committed artefact and a third-party client. Inlining costs bytes and keeps the
  document stable; the depth walk refuses a `$ref` that appears anyway.
- **A schema from a second copy of zod.** `isHostZodSchema` looks for the
  internals the host's own zod writes. zod is a shared host package for this
  reason and no other: it holds no process-wide state, but an action's schemas
  cross from a plugin into the host, which converts them and validates against
  them, so what matters is which module the object came from.

The input document is published under `io: "input"` for a reason of its own:
output mode makes a key with a default **required**, and a model reading that
will dutifully supply a value for every field the platform was perfectly happy to
choose itself.

One further refusal at registration is not about the schema. An action whose
`effect` is `delete` must declare `needsConfirmation`. A delete is the one effect
with no undo, and a client uses that flag to decide whether to ask the person
first. The flag lives on the definition the bundle registers rather than in the
manifest, so the manifest cannot answer for it and the registry refuses it here
instead.

## Strict at every depth

Every published input document refuses unknown keys at every depth, and
`assertStrictAtEveryDepth` proves it before the action is registered. A root that
is not an object schema is refused outright.

Nesting is where this gets missed. `z.object()` strips unknown keys at runtime
but emits no `additionalProperties` at all, so a plain object nested inside a
strict one produces a document promising a caller that a key is acceptable while
the write then happens without it. That is "answered saved and it was not",
reintroduced on the surface a model reads - and the model has no way to notice,
because the call succeeded.

Use `z.strictObject()` everywhere. The walk covers every subschema carrying
`properties`, every branch of `oneOf`, `anyOf` and `allOf`, and `items`, and it
names the path it refused so the fix is one field rather than a hunt.

## The annotations a client decides with

An MCP client decides whether to ask the person before calling from four hints,
and the mapping is not obvious because two of the four **default to true**. An
action that says nothing about itself is read as destroying something and as
reaching a system outside the instance, so it has to say for itself that it does
neither.

| Hint              | From the definition                                       |
| ----------------- | --------------------------------------------------------- |
| `readOnlyHint`    | `effect === "read"`                                       |
| `idempotentHint`  | `idempotent`                                              |
| `openWorldHint`   | `openWorld`                                               |
| `destructiveHint` | `needsConfirmation \|\| (effect !== "read" && !additive)` |

`additive` carries the last one, and it is what separates a create from an
update: true when the act adds and overwrites nothing a person wrote.
`menu_create`, `news_create` and `page_create` are the whole of the first slice's
additive set, and a contract test pins that list so nothing joins it by accident.

`needsConfirmation` is on every action so a pending-changes queue could be added
later without changing a plugin. There is none today - writes land directly, and
what makes that acceptable is that every one of them is attributable.

The catalogue publishes the five declared fields rather than the four hints; the
hints are composed by the connector that speaks MCP.

## Refusals

Every refusal a bound service can raise travels with the action, in `errors`, as
an `ActionErrorSpec`: the machine-readable `reason` the handler raises, a `retry`
verdict, and a `messageKey`.

| Verdict         | What it means                                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `after-edit`    | The request was wrong and a different one would work. A taken address, a body holding something a news item may not hold, a stale revision. The caller changes the input and calls again.                       |
| `never`         | Nothing the caller can send changes the answer, because what stands in the way is a fact about the association rather than about the request. A mailing that has gone out; a consent only a board member makes. |
| `after-backoff` | The answer may change on its own. Nothing in the first slice raises one; read-only mode and the rate limiter do, and a connector needs one vocabulary for all of them.                                          |

A person reads a sentence and decides what to do. A model needs to know whether
trying again could ever work, because without that it either gives up on
something it could have fixed or retries something that can never succeed.

`messageKey` points at the sentence the board's own screens already show -
`siteAdmin.errors.slugTaken`, not a key written for callers. A second set of
sentences would be a second thing to keep true, and the first time the two
disagreed a person and a model would be told different stories about the same
refusal.

The lists are in `apps/api/src/actions/action-errors.ts`, one per write service,
each enumerating exactly what that service's own reason union declares. A
contract test asserts that every action publishes at least one and that every
verdict is one of the three.

The registry's own refusals are separate, and are published as data too.
`ACTION_ERROR_REASONS` names them; `ACTION_ERROR_MCP` says how a connector should
render each, as a protocol error or as a tool result, with a retry verdict. That
distinction is what matters to a model: a protocol error means the call never
happened, a tool result means it happened and was refused, and only the second is
worth telling the person about. It is served on the catalogue endpoint so a
connector does not re-derive it from a status code, and so two connectors cannot
disagree about whether a 403 is worth retrying.

## What no action may do

`apps/api/src/actions/action-denylist.ts` is Beslutslogg 64 in code: four
constants, read by the boot gate and by the contract test over the catalogue.
They are constants rather than a rule derived from something else, because a
reviewer has to be able to check the list against the decision without running
the program.

**`DENIED_ACTION_CAPABILITIES`** - what no action of any kind may declare, core
actions included: `systemRole:manage`, `boardPosition:manage`,
`association:manage`, `protectedData:reveal`, `addressBook:write`. Each is a way
authority moves, or the way protected personal data is revealed, and an action
holding one would be a token able to widen what the token itself may do. A
capability moves in more ways than by being granted: a residency write moves one,
and so does installing or removing a plugin.

**`PLUGIN_ELIGIBLE_CAPABILITIES`** - what a plugin's action may ask for at all:
`self:manage`, `addressBook:read`, `site:manage`. An explicit allowlist rather
than a relation derived from the plugin's own route capabilities.
`routeCapabilityFloor` returns exactly two values, so an equality rule would mean
no plugin could ever declare a `site:manage` action - which is the case the
arming toggle exists to govern - and there is no ordering on the capability names
for "at or above" to mean anything. The separate question, that an action is
never reachable by a caller the plugin's own routes would refuse, is answered per
call by the floor check inside `invoke()`.

**`DENIED_ACTION_SERVICES`** - services no handler may be bound to:
`MoveService`, `SystemRoleService`, `BoardPositionService`, `PluginAdminService`,
`MemberRegisterService`, `ApartmentRegisterService`. This is the half a name
pattern cannot do. An action called `update_household` walks past any regex and
into the member register; what stops it is which service its handler calls, and
the contract test sweeps every `src/**/*-actions.registrar.ts` in the tree for
these names, so a registrar added later is covered without anybody remembering
to list it.

`ApartmentRegisterService` is on the list because it writes three append-only
statutory registers - the termination register, the transfer reversal register
and the reporting obligation ledger - and each is held append-only by a database
trigger, so a row an action put there could not be corrected by anybody.

**`DENIED_NAME_PATTERNS`** - names describing an act no action may perform:
`residency`, `move_in`, `move_out`, `plugin_install`, `plugin_remove`, `archive`,
`reveal`, `system_role`, `board_position`. The cheap half, and worth having
despite the service check above: a name is what a model reads and what a board
member sees on a consent screen, so an action that merely sounds like one of
these is already misleading.

One more refusal sits beside them, and it is made twice. An action declaring the
`protected` personal-data category may not list `mcp` or `ai` among its surfaces.
`protected` marks an action that can return a field of a person carrying
protected personal data (skyddade personuppgifter), and Beslutslogg 64 puts that
data outside every token and every prompt. It is refused from the manifest, where
the board can still act on it, and again at registration, which is what makes it
hold for a core action as well. Two moments over two different objects rather
than two opinions: a manifest declaration and a registered definition can
disagree.

## What an action that names a person must satisfy

Two rules, and they decide what may be bound rather than only what must be
declared.

**An action may bind a read only where the masking or the omission happens
inside the service method its handler calls.** Where the decision sits higher up

- in a controller, in a response mapper, in a component - the action reaches past
  it and must declare `protected`; and since `protected` bars `mcp` and `ai`, such
  an action is offered nowhere beyond the instance and is not worth registering. So
  rule 1 is not only about a declaration: it is the test for whether a read is
  bindable at all. The product makes it easy to apply, because the pattern is
  already everywhere - a service withholds a protected person's name from its own
  view, inside the service, with a discriminated branch rather than a blank.

**A withheld value is a different shape in a published output document, never an
empty one.** Publish it as a `z.discriminatedUnion` over `z.strictObject`
branches, each branch described, and never as a nullable string. A model reading
`""` or `null` concludes the association holds nothing; a model reading a branch
named `protected` concludes the value is withheld, and the difference decides
whether it asks a person or concludes there is nothing to ask about. The product
already does this - a masked contact is `{ state: "masked", hasEmail, hasPhone }`
and a protected author is `{ kind: "protected", personId }` - and the identifier
stays on the branch deliberately, so the row can be addressed without the person
being named.

The declaration is checked, but only the cheap half, and the contract test says
so in its own comment. `PERSON_FIELD_CATEGORIES` maps a property name a
person-bearing output uses - `name`, `email`, `phone`, `personId`, `apartment`,
`postalAddress`, `personalIdentityNumber`, and anything ending in `PersonId` - to
the category it implies, and the test walks each action's published output
document and fails on a property whose implied category is undeclared. It catches
the failure that actually happens: a field added to a service's view and echoed
by an action whose declaration was written before the field existed. It cannot
prove a declaration complete - a town returned under a property called `place`
passes it - and proving that a declared category is a reachable one is not built
at all, because it would need the registry to know what every bound service can
return.
