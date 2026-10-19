---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Turn the chat into a feed underneath: one stream of posts and comments for the
house, the board and each group (ADR 0026). This release changes the schema and
the API; the screen still shows the chat's rooms, and the feed's own screen
follows.

Every post is for one audience. Alla is everybody who lives here and the board;
Styrelsen is whoever holds a board seat, and is what the board chat was; and
each group is an audience of its own. One check decides who is in an audience,
and every path that reads or writes a post, a comment, a like or a read record
asks it. A group and its posts are invisible to anybody outside it: on no list,
in no search or filter, and a post asked for by its identifier is refused exactly
as one that does not exist (ADR 0012). The administrator, who holds every
capability and lives nowhere, is in no audience.

The migration renames the chat's tables rather than copying them. Every message
becomes a post in the audience its room became, with its identifier, its date -
and so its purge date - and its strike unchanged, and every room's read markers
become its audience's. Every news item that has been published becomes a board
post to Alla at the instant it was published, and its comments become the
post's: there is one comment model now. Publishing a news item puts it in the
feed from then on.

`GET /api/feed/audiences`, `GET /api/feed/posts` (newest first, pinned posts on
the first page, filtered by audience, search, who wrote it and whether it is
important) and `GET /api/feed/posts/since` (the poll, on the same
`(createdAt, id)` cursor as before) read the feed; `POST /api/feed/posts` writes
a post; a post has its own address at `GET /api/feed/posts/:id`, comments under
`/comments`, a like under `/like` and a read record under `/read`, which the
post reports as "read by N" and never as names. Groups and reports moved to
`/api/feed/groups` and `/api/feed/reports`, and the old `/api/chat` routes are
gone. The browser reads the same wire types the server writes, from
`@openbrf/shared`.

One purge erases a resident's post or comment a year after it was written, on
its own clock, and takes a post's likes, read records, reports and history with
it; a board post follows its news item. A post never takes a comment with it:
each comment is its writer's, erased on its own date or its writer's granted
erasure request and kept under its writer's legal hold or restriction. A post
with a comment still under it is erased rather than deleted - its text and its
author go, and the row stays as the place the comments answer, shown as erased
(`erasedAt` on the post) and taking no comment, like or report, until the last
comment under it has gone. The chat screen shows such a message as erased.

A granted erasure request reaches all of it as one domain, `feed`, and the data
subject access report states it in three sections: what the person wrote in the
feed, audience by audience, with how many posts they liked and opened; their
comments; and the posts they reported or answered.

The capabilities `chat:participate` and `chat:moderate` and the chat's audit
actions keep their names.
