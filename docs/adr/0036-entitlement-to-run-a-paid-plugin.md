# ADR 0036: Entitlement to run a paid plugin

Date: 2026-10-19

## Status

Proposed. A stub. Its context comes from gap G1 in
[the AI package gap audit](../ai-package-gap-audit.md#g1-a-licence-to-run-a-paid-plugin).
Its decision is written with the change that makes it, and only after
licensing has been decided (see the first question below).

## Context

ROADMAP.md says that paid "carries per-instance licensing". It sells the MCP
Connector "as a per-instance licence, sold on its own and included in the AI
package". Nothing in the core can express that today:

- The host object has no licence or entitlement member
  (`packages/plugin-sdk/src/host.ts:200-222`).
- A catalog entry cannot say that a plugin is paid
  (`packages/plugin-sdk/src/catalog.ts:109-154`).
- An installed plugin has no column for a licence
  (`apps/api/prisma/schema.prisma:2184-2253`).

The code is public, so whatever checks a licence can be removed by anyone who
runs the instance. Draft ADR 0034 (digital signage, #404) concludes from this
that the open code checks no licence at all. It enforces the entitlement only
where Apteo's own infrastructure is needed, at pairing and at player releases.
The MCP Connector and the AI package, with the association's own provider key,
need no Apteo infrastructure while they run.

## Questions the decision must answer

1. **Is a licence checked in open code at all?** If so, how does that sit with
   ADR 0034's rejected alternative "Licence checks in the plugin"? If not, what
   enforces "per-instance": the terms alone, or an Apteo-hosted part that the
   module cannot run without? Apteo decides the licensing terms and what its
   hosted part enforces; the maintainers decide what the core API offers
   (`GOVERNANCE.md`).
2. If a licence is checked, **what form does it take?** A signed file verified
   offline is the candidate. The instance should not contact Apteo to run, just
   as it contacts no package registry (`docs/deployment.md:1419-1426`).
3. **Who verifies it:** the host, offered to plugins as an entitlement they can
   read, or each plugin on its own?
4. **What does a missing or expired licence do?** The plugin should stop
   offering its features without losing anything. How does that relate to
   switching the plugin off, which is the board's act? Does disarming its
   actions follow, and is there a period of grace?
5. **How do the two products relate?** One licence for the AI package that also
   enables the connector, as ROADMAP.md says?
6. **What does the catalog listing and the consent screen say before
   install,** so a board does not install a module it cannot use?

## Constraints already fixed

- No free core feature may depend on a licence. The registry, sign-in, arming,
  the audit channel and the consent screen stay free (`ROADMAP.md:1281-1301`).
- A licence names an instance, never a person, and holds no personal data.
- Whatever is added to the host object is feature-detected by plugins, as
  `host.actions` is (`packages/plugin-sdk/src/host.ts:211-221`).
