# ADR 0039: Pending changes

Date: 2026-10-19

## Status

Proposed. A stub. Its context comes from gap G4 in
[the AI package gap audit](../ai-package-gap-audit.md#g4-holding-a-change-for-preview-and-confirmation).
Its decision is written with the change that makes it. Amends
[ADR 0008](0008-action-registry.md) once accepted ("Writes land directly, and
are attributable").

## Context

ROADMAP.md promises that with the AI package "a board member describes a change,
sees it as a preview and confirms it before anything is written"
(`ROADMAP.md:1302-1309`). Nothing in the core can hold a change until then:

- `needsConfirmation` is on every action "so a pending-changes queue could be
  added later without changing a plugin. There is none today - writes land
  directly" (`docs/actions.md:251-253`;
  `docs/adr/0008-action-registry.md:380-384`).
- The registry's only rule about the flag is that a delete must declare it
  (`apps/api/src/actions/action-registry.service.ts:173-182`).

The plugin cannot hold the proposal itself. It has no state it can write
(`packages/plugin-sdk/src/host.ts:45-52`). The store proposed in draft ADR 0033
(#404) is for configuration and never for people, and a proposed page or news
item can name a resident. Every column that names a person has to be answered
for by the data subject access report and by purging
([ADR 0019](0019-every-column-that-names-a-person-is-answered-for.md)), so the
proposal belongs in the core.

One case is already covered. A news mailing is "confirmed as a mailing in its
own right", and that is the mailing request: `news_request_mailing`, which a
board member answers in the web interface
(`apps/api/src/news/news-actions.registrar.ts:580`; GLOSSARY.md, "begäran om
nyhetsutskick").

## Questions the decision must answer

1. **What a pending change is**, and the term GLOSSARY.md gives it. It holds:
   - the action and its input;
   - who proposed it, and on which channel;
   - what it was proposed against, such as a page's revision, so a stale
     proposal is refused rather than applied over newer work;
   - its state: proposed, confirmed, rejected or expired;
   - when it expires.
2. **Which calls it holds.** Every write on `ai`? Only actions with
   `needsConfirmation`? Does `mcp` use it, or do MCP clients keep asking on their
   own side, as ADR 0008 assumes today?
3. **Who may confirm.** Is it the person who proposed, or anyone holding the
   action's capability? The capability is checked again at the moment of
   confirming, as the registry checks it on every call.
4. **What is recorded.** Is the confirmed write the confirming person's, on
   `web`, or the proposer's, on `ai`? Proposing and rejecting are acts of their
   own in the audit log.
5. **The preview.** Is it one generic rendering of the input, or a preview each
   action declares, such as the page as it would look? It follows DESIGN.md.
6. **Retention.** A pending change is service tier. When is it purged after it
   is decided or expires, and which section of the data subject access report
   carries it?

## Constraints already fixed

- The registry stays the one place a change is dispatched
  ([ADR 0008](0008-action-registry.md)). Confirming dispatches the held action
  through `invoke`, with every check made again. Nothing writes around the
  registry.
- A pending change holds nothing the held action could not write, and what the
  action's own input schema refuses is refused when the change is proposed, not
  first when it is confirmed.
- No action touching protected personal data is held on `mcp` or `ai`. The
  registry already refuses to offer such an action there
  (`apps/api/src/actions/action-registry.service.ts:185-207`), so a change
  proposed on those channels cannot name one. Such an action is allowed in
  process, on the platform's own screens. Whether a pending change may be
  proposed there is part of question 2. If it may, the decision has to say how
  protected personal data is refused when the change is proposed.
