---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

An issue now has two layers, and only one of them is kept for good.

- **What stays.** The building record: the type, the status, the outcome, the
  apartment, the priority, and when the issue was reported and closed. This is
  what makes a repeat fault countable years later.
- **What goes.** The description, the free-text location, the messages, the
  internal notes and every photograph and handler's file, which are removed
  from storage and not only from the issue. A file whose stored copy cannot be
  removed stays on the issue, and so does the text: the next night tries again,
  and an erasure request stays open until it has succeeded. A nightly job
  removes them a number of years after the issue closed. The board sets that
  number under Settings, from one to ten years; a new instance and an upgraded one start at two. The
  issue then says, with the date, that its free text was removed.
- **Legal hold on an issue.** A handler can place a legal hold on an issue, and
  release it again. While it stands, the issue keeps its free text past its
  clock and nobody can redact it. A legal hold or a restriction on the reporter
  keeps their issues in the same way.
- **Redaction.** A handler can redact the description, the location, a message
  or a note, and remove a photograph or a file, at any time. The text is
  emptied and the issue shows that it was removed and when; nothing keeps the
  earlier words, and no replacement text is taken. This is how the board
  carries out an erasure request from somebody named in an issue another
  person reported.
- **Erasure requests.** A granted erasure request now removes the free text of
  the issues the person reported, on the night after the board granted it,
  rather than leaving it to the clock. An issue that is still open, or under a
  legal hold, is kept until it closes or the hold is released, and the request
  stays open meanwhile and says why.

A person's access report says when the text of an issue they reported was
removed, whether a handler redacted it, the nightly job removed it or a granted
erasure request did, instead of printing it blank.

Every redaction, legal hold and change of the setting is recorded in the audit
log with who did it, and never the text or a file's name.

From the first night after upgrading, the free text of every issue closed more
than two years earlier is removed, at most 500 issues in each run, oldest closing
first. A board that wants to keep it longer sets a longer clock before that
night.
