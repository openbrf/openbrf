---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

The feed does four things a noticeboard does not (ADR 0026).

**Unread, live.** "Flöde" in the navigation shows how many posts are unread
across every audience you are in. On the feed, a line marks what is new since
your last visit. Every audience's count refreshes with the feed's poll, not
only the open one's, and the navigation's every thirty seconds on every other
screen. Both pause while the tab is hidden.

**A post becomes an issue report.** On a post you wrote, or as a board member on
any post you can read, "Gör felanmälan" opens the issue report form filled in
with the post's text and images. Sending it links the report to the post, and
the post then shows where the report stands. Only the report's reporter and
whoever handles issues see that; the post does not show it to anybody else.

**Must-read.** On a post the board marked important, the board can list who in
the audience has not opened it yet. Everybody else sees the count, as before.

**Edit with history.** You can edit your own post or comment, which then reads
"redigerad". You and the board can read the earlier versions; nobody else can.
A post the board struck through can no longer be edited, and one post or
comment keeps twenty earlier versions. The earlier versions are on your access
report and are erased with the post.

The board can also withdraw a post it scheduled, from "Schemalagda inlägg",
until it is published. That includes a post scheduled to Styrelsen or
Administratörer, which the news screen does not list.

API changes:

- New endpoints: `PATCH /api/feed/posts/<post>`, `GET
/api/feed/posts/<post>/revisions`, `GET /api/feed/posts/<post>/not-read`,
  `PATCH /api/feed/comments/<comment>`, `GET
/api/feed/comments/<comment>/revisions` and `DELETE
/api/feed/board-posts/<post>`.
- A post carries `issue`, `mayReportIssue`, `mayEdit`, `mayReadHistory` and
  `mayListNotRead`; a comment carries `mayEdit` and `mayReadHistory`; an
  audience carries `readAt`.
- `POST /api/issues` takes an optional `postId`, and refuses it with
  `post-not-found`, `post-not-reportable` or `post-already-reported`.
- New feed refusals: `not-editable`, `too-many-edits`, `history-withheld`,
  `not-important` and `not-scheduled`.
- The access report lists the earlier versions of each post and comment
  (`earlierVersions`).
