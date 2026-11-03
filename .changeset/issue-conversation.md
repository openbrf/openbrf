---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

The reporter of an issue and the people who handle it can now write to each
other on the issue, and the handlers keep notes and files of their own beside
the conversation.

- **Messages.** A resident writes on their own report, and whoever handles the
  issue answers in the queue. A handler's message reaches the reporter signed
  by the board or by the property manager, never by a person. The handlers see
  who wrote each message; a handler with protected personal data is not named
  to anyone. A reporter's message is refused on a report that is closed; a
  handler's is not. A handler cannot write to an issue nobody can read the
  answer on: an internal issue, or a report from the website's form, whose
  reporter has no account to read a conversation in.
- **Internal notes.** Handlers write notes for each other on an issue. The
  reporter never sees them. Every handler the issue lets in reads them, so the
  property manager does not see the notes on an issue the board keeps to
  itself.
- **Files for handlers.** Handlers attach an image or a PDF, such as a quote or
  a protocol, for each other. The reporter cannot open one, even from its
  address, and neither can a handler the issue no longer lets in.
- **Saved replies.** The board writes saved replies under Settings, and a
  handler inserts one into a message, edits it and sends it. A new instance
  starts with two: one acknowledging the issue and one saying that the bylaws
  and the law decide whether what was reported is the tenant-owner's to
  maintain. An instance
  already set up gets the same two when it upgrades, in its own language. They
  are templates for the board to reword to its own bylaws.

Text a handler writes, in a message, a note or a saved reply, is refused while
it carries a personal identity number. What a reporter writes is stored as
written, as the report itself is.

No mail carries what was written in a message or a note. Nothing of the
conversation is offered to a connected app or the AI package. Writing a message
or a note is recorded in the audit log with who wrote it, and never what. The purge detaches a purged person from what they wrote and leaves
the words with the issue.
