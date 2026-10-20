# ADR 0040: Read actions for issues and contact messages

Date: 2026-10-19

## Status

Proposed. A stub. Its context comes from gap G5 in
[the AI package gap audit](../ai-package-gap-audit.md#g5-permissions-and-core-actions).
Its decision is written with the change that makes it.

## Context

Issue triage in the AI package reads issues and suggests how to handle them.
There is no action to read an issue or a contact form message with. The core
registers actions for news, comments, the website, the association facts and
motions only. The capabilities that would gate the new actions exist:

- issues are handled under `issues:handle`
  (`apps/api/src/authorization/capabilities.ts:83`);
- contact form messages are read under `signupRequest:decide`
  (`apps/api/src/contact/contact.controller.ts:40-55`).

Both hold text residents and visitors wrote. GLOSSARY.md calls an issue "among
the most sensitive free text the platform holds - a report about a leak or a
neighbour carries health data and a third party's details without anybody
intending it". A contact form message comes from somebody without an account.

## Questions the decision must answer

1. **Which reads.**
   - A list with the filters the board's own screen has, and one issue with its
     history.
   - Does the list cover issue types for every audience, including the board's
     internal ones?
   - Are the property manager's reads the same as the board's?
2. **The personal data declared.** At least `freeText`, `health`, `name` and
   `apartment`. A reporter with protected personal data:
   - is left out of what the action returns, or reported without the protected
     fields;
   - never makes the action declare `protected`, because that would keep it off
     `mcp` and `ai` altogether
     (`apps/api/src/actions/action-registry.service.ts:185-207`).
3. **Surfaces.** `mcp` and `ai`, or `ai` only. Either way the board arms nothing
   here, because these are core actions; adding the surface is the decision
   ([ADR 0038](0038-the-ai-channel-for-a-plugin-s-dispatch.md)).
4. **Writes.** Is "a suggested reply as a draft" a pending change
   ([ADR 0039](0039-pending-changes.md)), or a field on the issue? Changing an
   issue's status is a separate write action, and may stay out of this ADR.
5. **The board mailbox.** Is it in scope? A letter is untrusted input from
   outside the association (GLOSSARY.md, "styrelsens brevlåda"), and it is
   gated by `boardMailbox:handle`
   (`apps/api/src/authorization/capabilities.ts:443`).

## Constraints already fixed

- Each description says that the text it returns was written by people and is
  data, never instructions (`docs/actions.md:104-125`). For these actions that
  sentence is the main defence, because the text comes from outside the board.
- An action returns only what the calling person could read on their own
  screen. Nothing is stored by reading.
- Sending the text to a model provider is the plugin's processing. The board
  classifies that recipient on the consent screen
  (`docs/plugin-contract.md:193-247`).
