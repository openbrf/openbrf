# ADR 0041: Read actions for documents and meetings

Date: 2026-10-19

## Status

Proposed. A stub. Its context comes from gap G5 in
[the AI package gap audit](../ai-package-gap-audit.md#g5-permissions-and-core-actions).
Its decision is written with the change that makes it.

## Context

The document assistant answers from the association's own documents. Meeting
support drafts an agenda and minutes. Neither the document archive nor the
general meeting has an action today.

- A document holds a title, a binder, an audience and a stored file, and no
  text (`apps/api/prisma/schema.prisma:3525-3560`). The board manages the
  archive under `documents:manage` (`apps/api/src/documents/documents.controller.ts:96`),
  and members read what is for the members or for anyone.
- A general meeting holds its day, its agenda with each item's decision, its
  notice, who attended and the proxy authorisations. It is managed under
  `meetings:manage` (`apps/api/src/authorization/capabilities.ts:317`).
  The minutes are not in it: they are filed in the document archive (GLOSSARY.md,
  "föreningsstämma").
- Motions already have three actions, offered on `ui` and `mcp` and not on `ai`
  (`apps/api/src/motions/motion-actions.registrar.ts:167-178`, `:223`, `:287`,
  `:305`).

## Questions the decision must answer

1. **Document content.**
   - Does an action return the stored file for the caller to read?
   - Or does the core extract text? If it does, where is the text kept? Stored
     files are encrypted at rest
     ([ADR 0015](0015-stored-files-encrypted-at-rest.md)), and text kept beside
     one must be encrypted and removed with it.
2. **The audience.** The archive's own rule decides, as it does for the
   document list block. A read returns only what the calling person may read:
   - the board's shelf to the board;
   - the members' shelf to a member;
   - the public shelf to anyone.
3. **Which meeting reads.**
   - The agenda, the decisions and the notice are what meeting support needs.
   - Attendance, proxy authorisations and the voting register name members.
     Are they offered on `ai` at all?
4. **Drafts.** Is an agenda draft written as a pending change
   ([ADR 0039](0039-pending-changes.md))? The agenda cannot be rewritten once
   the notice has been issued. Is a minutes draft a document, which needs a
   document write action?
5. **Motions on `ai`.** Are the existing motion actions offered on `ai` too, by
   the review [ADR 0038](0038-the-ai-channel-for-a-plugin-s-dispatch.md)
   settles?

## Constraints already fixed

- A protected person never reaches `mcp` or `ai`
  (`apps/api/src/actions/action-registry.service.ts:185-207`).
- Every serve of a board document is audited and gated by a capability
  (GLOSSARY.md, "dokumentlista"). A read action through the registry is no
  exception.
- Minutes name the members who spoke, so they are the members' unless the board
  publishes them (GLOSSARY.md, "dokumentarkiv").
