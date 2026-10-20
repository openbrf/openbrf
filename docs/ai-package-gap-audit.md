# The AI package and the MCP Connector: gap audit

Both modules are listed under Paid modules in [ROADMAP.md](../ROADMAP.md), and
both are to be built on the public plugin API and nothing else. The MCP
Connector lets a client that speaks the Model Context Protocol act as the member
who signed it in. The AI package adds a document assistant, issue triage,
meeting support and editing the website from a prompt, and includes the
connector.

The module plan named eight gaps, G1 to G8, between what the two modules need and
what the core offers today. This audit checks each one against the code and
gives it a verdict with the evidence. Where the plan was wrong or incomplete, the
audit says so, and it adds two gaps the plan did not name. Each core change the
audit confirms gets a proposed ADR, numbered 0036 to 0041, which records the
context and the questions its decision has to answer.

Line numbers refer to commit `65120de1` on `main`. Paths are from the repository
root.

## Verdicts

| Gap | What the plan said                                                 | Verdict                                                                     | Tracked in                                                                                                                    |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| G1  | Nothing lets an instance run a paid plugin under a licence         | Confirmed. The approach conflicts with a draft ADR                          | [0036](adr/0036-entitlement-to-run-a-paid-plugin.md)                                                                          |
| G2  | No declared outbound hosts; no secret setting                      | Confirmed, both halves                                                      | [0037](adr/0037-declared-outbound-hosts-and-secret-settings.md)                                                               |
| G3  | A plugin's dispatch is recorded as `plugin`, never `ai`            | Confirmed, and wider: the surface is wrong as well as the channel           | [0038](adr/0038-the-ai-channel-for-a-plugin-s-dispatch.md)                                                                    |
| G4  | `needsConfirmation` exists, but nothing holds a change for preview | Confirmed                                                                   | [0039](adr/0039-pending-changes.md)                                                                                           |
| G5  | Few plugin permissions; no actions for issues, contact, documents  | Confirmed for the actions; the permission half does not block these modules | [0040](adr/0040-read-actions-for-issues-and-contact-messages.md), [0041](adr/0041-read-actions-for-documents-and-meetings.md) |
| G6  | Plugin views are not in the navigation                             | Confirmed; an open pull request closes it                                   | #399                                                                                                                          |
| G7  | No usage cap or rate limit for model calls                         | Confirmed. It can live in the plugin only if the plugin can keep state (G9) | The plugin, after G9                                                                                                          |
| G8  | No MCP server, but nothing in the API blocks one                   | Confirmed. One thing does block it in process (G10)                         | The connector, after G10                                                                                                      |
| G9  | (not in the plan) A plugin has no state it can write               | New                                                                         | Draft ADR 0033 in #404                                                                                                        |
| G10 | (not in the plan) A plugin cannot read an action's schemas         | New                                                                         | [0038](adr/0038-the-ai-channel-for-a-plugin-s-dispatch.md)                                                                    |

## What is already there

The plan listed what the core already provides. Each claim checks out:

| Claim                                                                                               | Evidence                                                                                                                                        |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Every action declares which of the surfaces `ui`, `mcp` and `ai` it is offered on                   | `packages/plugin-sdk/src/actions.ts:29`, `:150-151`                                                                                             |
| An administrator arms each plugin action                                                            | `apps/api/prisma/schema.prisma:2226-2244`; `apps/api/src/actions/action-registry.service.ts:799-814`                                            |
| Every action carries `needsConfirmation`; a delete must declare it                                  | `packages/plugin-sdk/src/actions.ts:145`; `apps/api/src/actions/action-registry.service.ts:173-182`                                             |
| No action moves authority, writes the register or reveals protected personal data                   | `apps/api/src/actions/action-denylist.ts:25-31`                                                                                                 |
| An action touching protected personal data is never on `mcp` or `ai`                                | `apps/api/src/plugins/plugin-action-gate.ts:125-143` (the manifest), `apps/api/src/actions/action-registry.service.ts:185-207` (registration)   |
| OAuth 2.1 sign-in, with opaque tokens looked up on every call                                       | [ADR 0009](adr/0009-mcp-sign-in.md), "OAuth 2.1, through the sign-in library already in the tree" and "Opaque tokens, looked up on every call"  |
| `oauthProtectedResource` is declared in the manifest, and the id `mcp-connector` is reserved for it | `packages/plugin-sdk/src/manifest.ts:219-231`; `apps/api/src/auth/protected-resource.ts:28-29`; `apps/api/src/plugins/plugin.errors.ts:100-108` |
| The audit channel has an `AI` value                                                                 | `apps/api/prisma/schema.prisma:2094-2111`; `apps/api/src/actions/actor-of.ts:20-26`                                                             |
| An action's description says that stored text is data, never instructions                           | `docs/actions.md:104-125`                                                                                                                       |

## G1. A licence to run a paid plugin

**Verdict: confirmed. The approach needs a decision first.**

Nothing in the core or the plugin contract can tell whether an instance may run
a paid plugin:

- The host object offers `id`, `permissions`, `logger`, `settings`, `mail`,
  `sms`, `jobs`, `addressBook` and `actions`, and nothing about a licence
  (`packages/plugin-sdk/src/host.ts:200-222`).
- A catalog entry has no field saying that a plugin is paid or needs a licence
  (`packages/plugin-sdk/src/catalog.ts:109-154`).
- An installed plugin has no column for one (`apps/api/prisma/schema.prisma:2184-2253`).
- Searching `apps/` and `packages/` for "licen" and "entitle" finds nothing
  about licences.

ROADMAP.md says that paid "carries per-instance licensing" (`ROADMAP.md:1283-1287`)
and that the MCP Connector is "Paid as a per-instance licence, sold on its own and
included in the AI package" (`ROADMAP.md:1299-1301`).

A conflict to settle before any work starts: draft ADR 0034 in #404 (digital
signage) decides that "the open code checks no licence: a check in code anyone
can read is a check anyone can remove". It enforces the signage entitlement only
where Apteo's own infrastructure is needed, and lists "Licence checks in the
plugin" under rejected alternatives. With the association's own provider key,
neither the MCP Connector nor the AI package needs Apteo's infrastructure while
it runs. That approach would leave them with no point to enforce at. The two
paid modules should not reach opposite answers to the same question, so
[ADR 0036](adr/0036-entitlement-to-run-a-paid-plugin.md) is written against 0034.

## G2. Declared outbound hosts, and a secret setting

**Verdict: confirmed, both halves.**

_Outbound hosts._ The manifest has no field for where a plugin connects to
(`packages/plugin-sdk/src/manifest.ts:191-232`). The catalog entry repeats only
the permissions, the personal-data categories, the actions and the protected
resource, so the consent screen can show them before download
(`packages/plugin-sdk/src/catalog.ts:119-153`). The plugin contract says why the
consent screen asks the board where a plugin sends personal data: "The manifest
cannot answer this one" (`docs/plugin-contract.md:193-247`). The screen asks with
no default chosen, because "the catalog says nothing a default could be read
from" (`apps/web/src/plugins/RecipientQuestion.tsx:20-24`).

What the plan missed: a declaration is consent text, not a fence. A backend
plugin runs at full process privilege, and its permissions "are not a security
boundary against hostile code" (`packages/plugin-sdk/src/permissions.ts:4-11`).
So a declared host only constrains a plugin if the host also offers the way out
and the catalog review checks that the plugin uses nothing else. The core
already has one rule for which addresses a connection may reach
(`apps/api/src/network/outbound-address.ts:5-28`).

_Secret setting._ A settings field is `text`, `number`, `boolean` or `select`
(`packages/plugin-sdk/src/settings-schema.ts:71-76`). The values are stored as
plain JSON (`apps/api/prisma/schema.prisma:2246-2247`). `GET
/api/plugins/:id/settings` returns every stored value to the browser
(`apps/api/src/plugins/plugins.controller.ts:234-237`,
`apps/api/src/plugins/plugin-admin.service.ts:914-931`). The settings-change
audit entry already leaves the values out, because "a setting can hold a key"
(`apps/api/src/plugins/plugin-admin.service.ts:958-959`). An API key entered
today is shown back on the admin screen, and sits in clear in every database
dump.

The broker package's gap audit (#407) asks for both, as its G6 "a declared and
audited recipient" and G10 "a secret settings field". One design should serve
both modules: [ADR 0037](adr/0037-declared-outbound-hosts-and-secret-settings.md).

## G3. The channel a plugin's dispatch is recorded on

**Verdict: confirmed, and wider than the plan says.**

The channel is derived, never passed in. A cookie request is `web`, a token
request is `mcp` (`apps/api/src/actions/action-caller.ts:62-84`). A plugin
dispatching from its own route turns `web` into `plugin` and leaves a token's
`mcp` as it is (`apps/api/src/actions/action-caller.ts:104-122`). Nothing mints
`ai`: apart from the enum and the mapping, `ai` appears only in
`apps/api/src/actions/actor-of.ts:23`,
`apps/api/src/actions/action-registry.service.ts:102` and the catalogue's query
filter. The enum's own comment calls the value "Anticipatory: no such package
exists yet" (`apps/api/prisma/schema.prisma:2100-2104`).

The plan missed that the channel also decides the **surface**, and with it the
arming. `plugin` maps to the `ui` surface
(`apps/api/src/actions/action-registry.service.ts:97-103`), and on `ui` a
plugin's action is allowed without an arming check (`:810-812`). No AI package
exists yet, so this is what one would meet if it dispatched from its own route.
It depends on how the request reached the route:

- **A board member's session.** The dispatch is recorded as `PLUGIN` and meets
  the `ui` surface. It would reach every core action offered in the product,
  rather than the ones offered to the AI package, and every other plugin's
  action offered on `ui`, armed or not. The audit log could not tell its writes
  from any other plugin's.
- **A connected app's token.** The channel stays `mcp`, so the `mcp` surface and
  its arming apply. The records do not show that an AI package was in between.

No core action is offered on `ai` either. All five registrars declare
`["ui", "mcp"]` and say on purpose that the `ai` surface is a later decision:

- `apps/api/src/news/news-actions.registrar.ts:71-73`, `:86`
- `apps/api/src/news/news-comment-actions.registrar.ts:121`, `:136`
- `apps/api/src/site/site-actions.registrar.ts:370-372`, `:383`
- `apps/api/src/site/association-facts-actions.registrar.ts:162`, `:174`
- `apps/api/src/motions/motion-actions.registrar.ts:167`, `:178`

So a correct `ai` channel would, on its own, leave the AI package with nothing
to call.

A constraint the work keeps: `list` and `invoke` take the request the plugin's
route is serving, and act as whoever sent it
(`apps/api/src/plugins/plugin-host.ts:413-452`). A plugin's background job has
no request, so it cannot dispatch at all. The AI package therefore acts only for
a signed-in person. That matches how the audit channel already defines it: "The
AI package, acting as the person who prompted it"
(`apps/api/prisma/schema.prisma:2100`). Triage runs when a board member asks for
it, not when an issue arrives.

The broker package's gap audit (#407, G1 "declared dispatch of core actions")
found the same breadth from the other side.
[ADR 0038](adr/0038-the-ai-channel-for-a-plugin-s-dispatch.md) covers the
channel, the surface and the arming together.

## G4. Holding a change for preview and confirmation

**Verdict: confirmed.**

`needsConfirmation` is information for the caller. Nothing acts on it.
docs/actions.md says it "is on every action so a pending-changes queue could be
added later without changing a plugin. There is none today - writes land
directly" (`docs/actions.md:251-253`), and ADR 0008 says the same
(`docs/adr/0008-action-registry.md:380-384`). The registry's only rule about it
is that a delete must declare it
(`apps/api/src/actions/action-registry.service.ts:173-182`). Four actions set it:
`news_delete`, `news_comment_hide`, `page_delete` and `menu_remove`
(`apps/api/src/news/news-actions.registrar.ts:562`,
`apps/api/src/news/news-comment-actions.registrar.ts:225`,
`apps/api/src/site/site-actions.registrar.ts:751`, `:926`).

The plan puts the queue in the core, and the code supports that. A plugin cannot
keep a proposal itself: it has no state it can write (G9). The keyed store
proposed in draft ADR 0033 (#404) is for "configuration, never people", while a
proposed page or news item can name a resident. A proposal therefore has to be
somewhere the data subject access report and purging can answer for, as ADR
0019 requires of every column that names a person.

One part already exists: publishing a news item with its news mailing "confirmed
as a mailing in its own right" (`ROADMAP.md:1302-1309`) is what `news_request_mailing`
and the mailing request already do (`apps/api/src/news/news-actions.registrar.ts:580`;
GLOSSARY.md, "begäran om nyhetsutskick"). The queue does not need to cover it.
[ADR 0039](adr/0039-pending-changes.md).

## G5. Permissions and core actions

**Verdict: confirmed for the actions. The permission half does not block either
module.**

The plan made three claims:

1. _Plugin permissions are only the address book, mail, SMS and jobs._ True
   (`packages/plugin-sdk/src/permissions.ts:15-47`). It does not matter here.
   Both modules reach the association's records through core actions, as the
   signed-in person, and not through host services.
2. _A plugin's own action may only need `self:manage`, `addressBook:read` or
   `site:manage`._ True (`apps/api/src/actions/action-denylist.ts:45-49`). It
   would matter only if the AI package declared actions of its own under, say,
   `issues:handle`. The plan has it dispatch core actions instead, so this is
   struck as a blocker.
3. _Core registers actions for news, comments, the site, association facts and
   motions only._ True. The registrars are listed under G3. There is no action
   for issues, contact form messages, the document archive, general meetings or
   the board mailbox. The capabilities to gate them already exist:
   `issues:handle`, `documents:manage`, `meetings:manage` and
   `boardMailbox:handle` (`apps/api/src/authorization/capabilities.ts:83`,
   `:111`, `:317`, `:443`). Contact form messages are read under
   `signupRequest:decide` (`apps/api/src/contact/contact.controller.ts:40-55`).

What the plan missed:

- None of the existing actions is offered on `ai` (see G3).
- A document holds no text, only a title, a binder, an audience and a stored file
  (`apps/api/prisma/schema.prisma:3525-3560`). A document assistant needs text,
  so how a read action gets it is a decision of its own.

[ADR 0040](adr/0040-read-actions-for-issues-and-contact-messages.md) and
[ADR 0041](adr/0041-read-actions-for-documents-and-meetings.md).

## G6. Plugin views in the navigation

**Verdict: confirmed, and already being closed.**

A plugin view is reachable by its address only (`ROADMAP.md:468-469`). The route
exists (`apps/web/src/routes/PluginViewRoute.tsx:34-42`), and the navigation is
built from a fixed list with no plugin entries
(`apps/web/src/shell/nav-items.ts:513-530`). Pull request #399 adds the section a
manifest names. This audit adds nothing to it.

## G7. A usage cap for model calls

**Verdict: confirmed. "In the plugin" holds only after G9.**

Nothing in the core caps or counts calls to a model provider. The core's one
per-caller limit is per connected-app token, in memory, and resets when the
process restarts (`apps/api/src/auth/token-rate-limit.ts:1-18`;
`docs/adr/0009-mcp-sign-in.md:213-237`). That limit already bounds the MCP
Connector.

A cap per instance per month needs a counter that survives a restart, and
installing any plugin restarts the process. A plugin cannot write one:

- `host.settings` only reads (`packages/plugin-sdk/src/host.ts:45-52`).
- The database is one of the core services a plugin may not inject
  (`apps/api/src/plugins/plugin-module-seal.ts:189-193`).

The cap belongs in the plugin, as the plan says, once the plugin has somewhere
to keep it (G9). Until then, a per-process cap is the honest limit, and the
admin screen has to say that it resets.

## G8. The MCP server

**Verdict: confirmed. Nothing exists, and one thing blocks it in process (G10).**

"Core mounts no MCP route of its own"
(`apps/api/src/auth/protected-resource.ts:7-14`). Everything else the connector
stands on is there:

- The route is the plugin's own, declared as `oauthProtectedResource`
  (`packages/plugin-sdk/src/manifest.ts:219-231`).
- The guard makes it accept a Bearer token and nothing else
  (`apps/api/src/authorization/authorization.guard.ts:145-153`).
- A token request keeps `mcp` through the plugin's dispatch
  (`apps/api/src/actions/action-caller.ts:116-119`), so the connector's writes
  are recorded on the right channel without a core change.
- `mcp` is a surface that requires arming
  (`apps/api/src/actions/action-registry.service.ts:810-813`).

Bundling: a plugin declares no runtime dependencies
(`packages/plugin-sdk/src/manifest.ts:299-338`), and its server entry is a CJS
bundle whose only externals are the host packages and Node's built-ins
(`docs/plugin-contract.md:251-255`). An MCP SDK has to be bundled in. zod is a
host peer dependency (`docs/plugin-contract.md:290-302`), so the bundle must use
the host's zod or keep its own copy away from any schema handed to the host.
`pluginPackageProblems` checks the result (`docs/plugin-contract.md:702-709`).

What blocks it is G10: MCP's `tools/list` needs each tool's input schema, and a
plugin cannot get one.

## G9. A plugin has no state it can write (new)

A plugin can read its settings and nothing else of its own. It cannot write
them, and it cannot hold the database
(`packages/plugin-sdk/src/host.ts:45-52`,
`apps/api/src/plugins/plugin-module-seal.ts:189-193`, and the
`forbidden-injection` finding at `docs/plugin-contract.md:864-880`). This
affects G7, and anything the AI package wants to remember between requests.

Draft ADR 0033 in #404 proposes `host.records`, a keyed JSON store per plugin
that holds no personal data. A usage counter fits it. A conversation or a
proposal does not, because either can name a person. That is one more reason
for G4 to be in the core. No new ADR here: the AI package depends on 0033.

## G10. A plugin cannot read an action's schemas (new)

`host.actions.list` returns `ActionSummary`, which has no input or output
schema (`packages/plugin-sdk/src/actions.ts:184-213`,
`apps/api/src/plugins/plugin-host.ts:434-441`). Only the HTTP catalogue route
adds them (`apps/api/src/actions/action-catalogue.controller.ts:78-121`, through
`apps/api/src/actions/action-registry.service.ts:310-318`).

The MCP Connector needs them for `tools/list`, and the AI package's tool loop
needs them to describe each tool to the model. Calling the instance's own HTTP
catalogue from inside the process would mean replaying the member's token or
session over loopback. The fix is small: give `host.actions` the same schemas,
filtered as `list` already is. It belongs with the channel work in
[ADR 0038](adr/0038-the-ai-channel-for-a-plugin-s-dispatch.md), because both
change what `host.actions` offers.

## Checked and not a gap

- **Outbound network access.** The deployment documents the hosts an install
  needs (`docs/deployment.md:1419-1426`), and nothing in the production stack
  blocks other outbound HTTPS. The association's network may, and the module's
  documentation will say which host it needs.
- **A plugin writing to the audit log.** Not needed by either module if the
  pending-change queue is in the core, because the queue's entries are the
  record. Draft ADR 0035 in #404 proposes `host.audit` for plugins that need it.
- **Prompt-injection rules for action descriptions.** Already in place
  (`docs/actions.md:104-125`). New read actions inherit them.

## Order of work

0036 waits for a decision on licensing (see G1). 0037 to 0041 can be designed in
parallel. 0038 and 0039 come before any AI package feature that writes. The MCP
Connector needs 0036 and the schema half of 0038 (G10), and no other core change.
