# ADR 0041: Read actions for documents and meetings

Date: 2026-10-19

## Status

Accepted. Its context comes from gap G5 in
[the AI package gap audit](../ai-package-gap-audit.md#g5-permissions-and-core-actions).
The meeting reads are built with this record. The document reads were built in a
change of their own, because that change adds a PDF parser to the core and has a
security review of its own.

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

- An action that declares protected personal data (`personalData: "protected"`)
  is refused on `mcp` and `ai` when it is registered
  (`apps/api/src/actions/action-registry.service.ts:185-207`). The rule is
  about the data an action can return and not about who calls it. The reads
  here declare only `name` and `freeText`, so they are offered on `mcp` and
  `ai`, and a caller with protected personal data is served like any other
  member, by the shelf rule that decides who may read a file.
- Every serve of a board document is audited and gated by a capability
  (GLOSSARY.md, "dokumentlista"). A read action through the registry is no
  exception.
- Minutes name the members who spoke, so they are the members' unless the board
  publishes them (GLOSSARY.md, "dokumentarkiv").
  The text of minutes may name a protected person, and the reads do not mask
  it: the shelf rule is the control, as it is for the web archive.

## Decision

### Two changes, on `mcp` and `ai`

The reads are offered on `mcp` and `ai` and not on `ui`. The board's own screens
read documents and meetings through their controllers, with what they need to
run them, so an action on `ui` would add a second way to the same screen. They
are built as two changes: one for the meetings and one for the documents, which
brings a PDF parser into the core.

### Documents

1. **Document content.** The core extracts the text when a document is read,
   inside the request, from a PDF only and by page range. A size cap, a page cap
   and a time cap bound the extraction, and the text is not stored, so
   [ADR 0015](0015-stored-files-encrypted-at-rest.md) is unchanged: there is no
   second copy beside the encrypted file to encrypt or remove. A PDF without a
   text layer is answered as having none. There is no OCR. Search matches the
   title and the binder only, not the text.
2. **The audience.** The archive's own rule, `DocumentsService.list(principal)`,
   decides what a read returns. The board's shelf is not offered on `mcp` or
   `ai` in this round, so a board member reaching the archive through an app
   reads what a member reads. Both reads declare `name` and `freeText`.

### Meetings

3. **Which meeting reads.** Two reads under `meetings:manage`, the capability
   the board's meetings controller declares:
   - `meeting_list`: each meeting's day, kind, whether its notice has been
     issued and how many items its agenda holds, twenty to a call unless more are
     asked for and fifty at most, or the meetings of one year up to 2200;
   - `meeting_get`: one meeting with its agenda, each decision's outcome and its
     vote totals, and the notice's time, place and participation instruction.

   Attendance, proxy authorisations, the voting register, individual votes and
   whom the notice did not reach are offered on neither `mcp` nor `ai`. Each
   names a member, and none is needed to draft an agenda or minutes; the totals
   are what EFL 6 kap. 39 § has the minutes state about a vote. Which board
   member recorded a decision or issued the notice is left out for the same
   reason. `meeting_list` names nobody and declares no personal data;
   `meeting_get` declares `freeText` for the agenda and the notice, which the
   board wrote. `MeetingService.outline` reads the meeting without the persons,
   so the voting register is not drawn from the member register for these
   reads.

### Drafts

4. **Drafts.** An agenda draft is a pending change
   ([ADR 0039](0039-pending-changes.md)), and it is refused once the notice has
   been issued, as `MeetingService.setAgenda` is. A minutes draft is text
   returned to the board, not a document, so no document write action is
   needed. Both are built with the meeting support package's change, not here.

   _Amended 2026-10-22, with meeting support._ The agenda draft is proposed as
   `meeting_set_agenda`, a write under `meetings:manage` that replaces the
   whole agenda, as the board's own screen does. It is offered on `ai`, for the
   AI package to propose, and on `ui`, because ADR 0039 has a change confirmed
   on the platform's own screen and refuses a proposal for an action that
   screen is not offered. It is not offered on `mcp`, where a connected app's
   write would land directly. Its input names the agenda it replaces by its
   items' ids in their order, as `meeting_get` answers with them: every rewrite
   creates new items, so the ids are a revision of the whole list, and a change
   confirmed after somebody rewrote the agenda is refused with `agenda-changed`
   rather than written over the newer one. The check is made under the agenda
   lock, with the notice check. Once confirmed, the write is the confirming
   board member's on `web`, and its audit entry names the pending change. It
   declares `freeText`: the items are the board's text. The board's own screen
   sends no expected agenda and is unchanged.

### Motions

5. **Motions on `ai`.** Whether the existing motion actions are offered on `ai`
   is decided in [ADR 0038](0038-the-ai-channel-for-a-plugin-s-dispatch.md).

## Consequences

- The catalogue's contract test pins which actions are offered on `ai`, so each
  one added there is a line a review sees.
- Each read has tests of who may call it (the capability, the surface and the
  token's scope) and of what it may carry. The meeting reads are tested against
  a meeting where a member with protected personal data attended, voted, gave a
  proxy authorisation and was not reached by the notice.
- `ai` is declared now and is reachable once the `ai` channel of ADR 0038 is
  built. Until then the reads are reachable on `mcp` only.

## Revisit triggers

- The board's shelf is wanted on `mcp` or `ai`. That needs the audit and the
  capability gate GLOSSARY.md asks for every serve of a board document.
- Associations need the text of scanned PDFs. OCR is a processing step of its
  own, with its own cost and its own error rate.
- A member-facing meeting read. These are the board's; what a member reads
  about a meeting is a separate decision.
