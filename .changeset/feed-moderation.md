---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

The board moderates what the house writes in Alla, and its report queue reaches
every report (ADR 0026). This completes the feed.

**Striking through in Alla.** A board member strikes a resident's post or a
comment in Alla through from the feed itself, without waiting for a report. The
control sits with the board's other controls under the board's sign, and asks
once more before it strikes, because a strike cannot be undone. The text, and a
post's images, are then hidden from everybody else who reads Alla. The writer
and the board still read them, and nothing is erased. A strike closes every open
report of what it struck.

**Reporting a post or a comment.** Residents can report a post in Alla to the
board, and a comment under any post in Alla or in a group, as well as a post in
a group as before. A comment's report carries the comment alone: from a group,
the board sees neither the post it answers nor a way to reach it. In a group the
board still acts only on a report, and a board member who is in the group is
refused a strike there without one. Nothing in Styrelsen or Administratörer, and
no post written as Styrelsen, can be reported or struck. Nobody can report their
own post or comment, a board member cannot report what is said in Alla, where
they strike instead, and one person can make ten reports in an hour. A post or
a comment the reader has already reported is no longer offered for reporting, also
after the page is reloaded.

**A paged report queue.** The queue used to show the first fifty open reports,
and nothing after them could be reached. It now reads fifty at a time, oldest
first, and the next fifty are a press away. A report the board settled
elsewhere, from the feed or by another board member, leaves the queue when
pressed and says so. A report the purge has taken with what it was about leaves
the queue the same way, once the first page is read again. When every report
shown has been answered and more are waiting, the queue says so above the button
that reads them, and a queue the board has emptied says that every report has
been answered rather than that nothing was reported. The overview's count of
reported posts says "at least" only when the queue has another page.

`GET /api/feed/reports` takes an `after` cursor and answers with `next`. A
report names a `postId` or a `commentId`, and carries the audience it came from.
`POST /api/feed/posts/:postId/strike` and
`POST /api/feed/comments/:commentId/strike` are new and need `chat:moderate`.
Posts and comments now say whether the reader may report them (`mayReport`) and
strike them (`mayStrike`).

`POST /api/feed/reports` refuses a report the reader is not offered, and refuses
a reader past ten reports in an hour with a 429. The access report names Alla,
rather than "a group", for a report made there.
