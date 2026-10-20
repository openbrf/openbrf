---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

Publish the 1.0 free/paid boundary in GOVERNANCE.md and ROADMAP.md.

The board decided the boundary on 2026-10-19. A module is paid only if it is
(a) a service Apteo runs, (b) a contract or account Apteo holds with a third
party, (c) design work sold as an optional theme, or (d) a module Apteo
licenses per instance that is named in a closed list in ROADMAP.md. Adding to
that list needs a board decision and is announced here. Statutory duties,
security controls (sign-in, access control, the audit log, backup and restore)
and data exports are never paid, and a core feature is never moved into a paid
module.

This removes "per-instance licensing" as a reason of its own and supersedes the
"delivery into another system" test in ADR 0011. What changes on the roadmap:

- The licensed modules are the MCP Connector, autogiro and bankgiro files, the
  approval step before a charge leaves, and parking space sharing.
- Every other paid module states its reason. Recurring address book import,
  digital signage, advanced finances and the advanced booking, broker and
  property manager packages are split, so the free part of each is named.
- Maintenance planning is free. Fee notice sending, the display mode for
  screens and re-running an address book import with a diff to review are on the
  roadmap as free.
- Reporting to Lantmäteriet, the transmission included, is never paid.

No code changes, and nothing that is free today becomes paid.
