# ADR 0038: The AI channel for a plugin's dispatch

Date: 2026-10-19

## Status

Proposed. A stub. Its context comes from gaps G3 and G10 in
[the AI package gap audit](../ai-package-gap-audit.md#g3-the-channel-a-plugins-dispatch-is-recorded-on).
Its decision is written with the change that makes it. Amends
[ADR 0008](0008-action-registry.md) once accepted.

## Context

The audit channel records which way a change reached the association's records,
and it has an `AI` value. The value is "anticipatory: no such package exists
yet" (`apps/api/prisma/schema.prisma:2094-2111`). Nothing mints it.

The channel is derived from how a request arrived and is never passed in: a
session is `web`, a token is `mcp` (`apps/api/src/actions/action-caller.ts:62-84`).
A plugin dispatching from its own route turns `web` into `plugin` and keeps a
token's `mcp` (`:104-122`). The channel then decides the surface: `plugin` maps
to `ui` (`apps/api/src/actions/action-registry.service.ts:97-103`), and on `ui` a
plugin's action needs no arming (`:810-812`).

If an AI package were written today and dispatched from its own route, the
channel depends on how the request reached that route:

- **A board member's session.** It is recorded as `PLUGIN` and reaches the `ui`
  surface. That is every core action offered in the product, and every other
  plugin's `ui` action, armed or not. It never meets the `ai` surface or the
  arming that decides what an AI package may reach.
- **A connected app's token.** It stays `mcp`, so it meets the `mcp` surface and
  its arming. The records do not show that an AI package was in between.

No core action is offered on `ai`. Each of the five registrars leaves it out on
purpose, as a decision for later (for example
`apps/api/src/news/news-actions.registrar.ts:71-73`). The broker package's gap
audit (#407, G1) found the same breadth from another side: nothing limits which
core actions a plugin dispatches.

Separately, `host.actions.list` gives a plugin no input or output schema
(`packages/plugin-sdk/src/actions.ts:184-213`). Only the HTTP catalogue does
(`apps/api/src/actions/action-catalogue.controller.ts:78-121`). The MCP
Connector needs the schemas for `tools/list`, and the AI package needs them to
describe each tool to a model.

## Questions the decision must answer

1. **How the host knows a dispatch is the AI package's.** A reserved plugin id,
   as `mcp-connector` is for the protected resource
   (`apps/api/src/auth/protected-resource.ts:28`,
   `apps/api/src/plugins/plugin.errors.ts:100-108`)? Or a manifest declaration
   the board consents to and the consent screen shows? Either way the host
   derives the channel. A caller never chooses it per call.
2. **What `ai` reaches.** Does the `ai` channel map to the `ai` surface, with
   arming applying to plugin actions as it does on `mcp`? What does a token
   request on that plugin's route record: `mcp`, because the connected app is
   what reached the records?
3. **Which core actions are offered on `ai`, and by what review.** Is it added
   per action group, with the descriptions' rule that stored text is data
   (`docs/actions.md:104-125`) checked again for a model as the reader?
4. **What the audit entry names.** A connected app is named on its entries. Does
   an `ai` entry name the plugin that dispatched?
5. **Other plugins.** Does the rest of the plugin dispatch stay on `plugin`/`ui`,
   or does this ADR also take #407's declared dispatch, so that no plugin
   reaches a core action it did not declare?
6. **Schemas in process.** Does `host.actions` gain each action's input and
   output JSON Schema, filtered exactly as `list` is, so a plugin can describe a
   tool it can call and nothing else?

## Constraints already fixed

- The caller is a handle only the core can mint
  (`apps/api/src/actions/action-caller.ts:7-20`). A plugin cannot name a person
  or a channel.
- A plugin dispatches only on behalf of the request its route is serving
  (`apps/api/src/plugins/plugin-host.ts:413-452`). The AI package therefore acts
  only for a signed-in person, never from a background job.
- An action touching protected personal data is never on `ai`
  (`apps/api/src/actions/action-registry.service.ts:185-207`).
- The audit log is append-only. Entries already written as `PLUGIN` stay so.
