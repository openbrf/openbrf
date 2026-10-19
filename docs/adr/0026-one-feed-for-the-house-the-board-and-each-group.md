# ADR 0026: One feed for the house, the board and each group

Date: 2026-10-18

## Status

Accepted. Supersedes the "no forum" decision recorded in ROADMAP.md under
"Comments on news items, then group and board chat" and in GLOSSARY.md under
`chatt` and `kommentar`. ADR 0010 and ADR 0012 stand unchanged.

## Context

The application has three places where people who live here write to each
other, and each was built as the smallest thing that answered one question.

- **A comment thread under each news item.** The board writes a notice, and the
  house can answer it. A comment is exactly as visible as its item.
- **The board chat.** The board's own room, whose members are whoever holds a
  seat today.
- **Groups.** A room somebody who lives here makes for a work party or a
  stairwell, invisible to everybody outside it (ADR 0012).

What none of them answers is the most ordinary question a house has: a resident
telling the neighbours something. The lift is out again, the bicycle room door
does not lock, there are plums on the tree by the gate. Today the only place to
say that is a group somebody has to make first, or a comment under a notice that
is about something else. The roadmap and the glossary recorded that "a full
discussion forum is deliberately never built and is integrated instead". No
integration was ever built, and the house's own noticeboard is the thing a
cooperative's members ask for first.

The three places are also three implementations of one thing. Each has its own
cursor, its own author mapping (`authorViewOf` was written three times, and a
fourth time for comments), its own membership test, and a web client that
mirrors the server's types by hand. A struck line in a group and a struck
comment under a notice are the same act with two names, two columns and two
audit actions.

## Decision

### One feed, and the rooms become audiences

There is one stream of posts. Every post is for one **audience** (målgrupp), and
there are three kinds:

- **Alla**: everybody who lives here, and everybody who holds a board seat that
  has not ended. The board is in it because it answers for what is written
  there and because what it posts as Styrelsen goes there.
- **Styrelsen**: whoever holds a board seat that has not ended. This is the
  board chat, unchanged in who is in it.
- **Each group**: whoever is written into it and still lives here. This is a
  group, unchanged in who is in it.

An audience is a row (`audience`), and a group is an audience of kind `GROUP`.
Alla and Styrelsen are one row each, enforced by partial unique indexes as the
board chat was. The administrator holds every capability, holds no seat and
lives nowhere, so they are in no audience, as they were in no room.

**One check decides it.** `apps/api/src/feed/feed-audience.ts` is the only code
that answers whether somebody is in an audience, and every path that reads or
writes a post, a comment, a like, a read record or a group asks it. A post asked
for by identifier, in an audience the caller is not in, is refused exactly as a
post that does not exist. List, search and filter run inside the caller's own
audiences and never outside them, and a search never matches text that is
withheld from the caller. That is how ADR 0012's promise holds for posts as it
held for rooms: a group is on no list, in no search, and refused by identifier
exactly as something that does not exist.

### Residents post to Alla: the "no forum" decision is reversed

A resident writes a post to Alla, and the neighbours can like it and comment on
it. What is still not built, and why:

- **No sub-threads.** Comments are flat and oldest first, as a news thread's are.
  A tree is where a conversation goes to be lost.
- **No delete.** What somebody wrote is a record of what was said, as it has
  been in every room. The board strikes through; nobody erases. The retention
  clock is the only thing that removes a post.
- **No direct messages and no mentions.** A post goes to an audience and is read
  by whoever is in it. A one-to-one conversation is a different product, and a
  mention is a notification this product does not send.

The argument recorded against a forum was that a cooperative is better served
by software built for one. That holds for a forum as a product - categories,
reputation, moderation teams - and none of that is built here. A noticeboard for
one house, whose readers are derived from the registers and whose posts are
erased on the service tier's clock, is not something an integration can offer,
because the integration would hold none of the registers.

### A board post is a news item

The board posts as Styrelsen. Such a post is a news item (`nyhet`) with a post
pointing at it (`post.newsId`), so "Viktigt meddelande" sends the news mailing
and publishing to the website stays available. A board post follows the news
item's own rules: it is shown while the item is published, it is not on the
service tier's clock, and it goes when the item goes.

Because a board post is a news item, **news comments become post comments**:
there is one comment model (`post_comment`). The news screen's thread and its
connected-app actions keep their published contract and read the comments of
the news item's post, under `news:comment` as before, until the feed replaces
that screen.

### What the migration does

Nothing is copied that can be renamed, so nothing moves in time.

- The board chat becomes the Styrelsen audience and each group its own audience,
  by renaming the tables they live in. A message becomes a post in its audience,
  keeping its identifier, its `createdAt` - so its purge date does not move - and
  its strike. A room's read markers become the audience's.
- Alla is created.
- Every news item that has been published, or that carries a comment, becomes a
  Styrelsen post to Alla, at the instant it was published. Its comments become
  that post's comments, keeping their identifiers, their instants and their
  strikes. Published to the street or to members only, a news item is read by the
  house, so the audience that matches either visibility is Alla. A draft that
  was never published is not in the feed and gets its post when it is.

### Delivery stays a poll on `(createdAt, id)`

ADR 0010 holds as written. The feed is read a page at a time from the newest
end and polled forwards from a cursor, both on `(createdAt, id)`, with the
comparisons written out so a purged row does not lose a reader's place. A post
scheduled for later is stored with `createdAt` set to the instant it is to
appear, and the feed reads only posts whose instant has passed. A poll's cursor
is never later than the moment it was taken, so a scheduled post is delivered by
the first poll after its instant rather than skipped because it was written
earlier. `scheduledAt` records that it was scheduled, which `createdAt` alone
cannot say.

### Two kinds of read record, for two different purposes

**How far somebody has read an audience** (`audience_read`) is the room's read
marker, carried over unchanged. It is what makes "new since your last visit"
answerable without mailing anybody about every post.

**That somebody opened a post** (`post_read`) is new, and it is personal data in
a way the marker is not, because it says that one named person read one named
thing. It is recorded for two purposes and no others:

- **"Läst av N"** on every post: a count, never names. It tells a writer that the
  house has seen what they wrote.
- **Must-read** on a post the board marks important: the board sees who in the
  audience has not opened it yet, so a notice about the water being shut off can
  be followed up with the households it has not reached. Everybody else sees the
  count.

The legal basis is legitimate interest (GDPR art. 6.1 f): the association has an
interest in knowing that what it must tell the house has reached the house, and
the residents have an interest in knowing that what they post is read. The
balance is held by what is recorded and who sees it. The row holds the person,
the post and the instant and nothing else; names reach nobody but the board,
and the board only for an important post in an audience it may read; and the
record is **erased with the post**, on a granted erasure request, and with the
person's other data in the feed. It is on the data subject access report.

### Edit with history

An author may edit their own post or comment, and it then shows as edited. The
earlier versions are kept in `post_revision` and `post_comment_revision`,
readable by the author and the board, and purged with the post. This departs
from "written once and never edited" and keeps its reason: what somebody wrote
stays a record of what was said, because the record is the history rather than
the latest text. The tables are created now and written by the change that adds
editing.

### Images on a post

A resident may put a few images on a post - four at most - and the text stays
required. An image is the writer's personal data in the same way the text is: a
picture of the bicycle room can have a neighbour in it.

- **Uploaded first, attached when the post is written.** Each image is uploaded
  on its own, one file per request like every other upload in the product, and
  the post names the uploads it carries. Only the writer's own uploads that are
  on no post yet, and less than a day old, can be named.
- **Served only through the post.** The file is held with a visibility of its
  own, `POST`, and the media route serves it to whoever may read the post it is
  on - the same audience check every other path asks - and to nobody else. No
  capability opens it, so the board reaches a group's image exactly as it
  reaches the group's post: through a report or not at all (ADR 0012). Asked
  for by its address from outside the audience, it answers as a file that does
  not exist. An upload on no post is served to nobody; the composer shows the
  writer their own copy.
- **Withheld with the text.** When the board strikes a group's post through,
  its images are withheld from the group with the text, and stay visible to the
  author and the board.
- **Erased with the post.** The purge removes the files when it deletes or
  erases the post, on the post's own date. An upload that was never put on a
  post is removed two days later; the one-day limit on attaching it is what
  keeps a post from being written with a file the purge is removing.
- **On the access report as a count**, as an issue's photographs are.

### Retention

Unchanged in substance, and in one place now.

- A resident's post or comment is erased 365 days after it was written, on its
  own clock (`feed-retention.ts`). A post that goes takes its likes, its read
  records, its reports, its history and its images with it: they hang on its
  text.
- A post never takes a comment with it. A comment is its writer's personal
  data, written on a date of its own, and whether it may be erased is a
  question about its writer - their window, their granted erasure request,
  their legal hold or restriction - that only the purge of that writer answers,
  under that writer's own locks. Erasing the comments under a post on the
  post's author's clock would erase a reply written yesterday a year early, and
  a held neighbour's reply past the hold placed to keep it. So a post with a
  comment still under it is **erased** rather than deleted (`Post.erasedAt`):
  its text, its author and everything that went with them go on the author's
  date, and the row stays as the place the comments answer. The feed shows it
  as erased, it takes no comment, like, read record or report - each of those
  writers reads the row under a share lock first, so none lands under a post
  being erased - and the purge deletes the row once nothing stands under it.
  A post nobody answered is deleted whole.
- A post written as Styrelsen follows its news item's rules and is not on the
  clock.
- A group whose last post is purged goes, with its member list, as before.
- A granted erasure request erases everything the feed holds of the person on
  the night it is granted, and `retention/erasure-domains.ts` counts it before
  the request is closed. A legal hold or a restriction stops both, as before.
- The advisory locks in `feed-lock.ts` are the chat's, under new names, and keep
  the same orderings.

### What keeps its name

- **The capabilities.** `chat:participate` opens the feed's endpoints and
  `chat:moderate` the report queue, exactly as before. A capability's name is a
  published part of the authorization model - the release notes name these two,
  and a reviewer reads the role grants by them - and the act each one guards has
  not changed: the first is every resident's and every board member's way in,
  the second the board's answer to a report. A new name would say the same
  thing in a new word, and leave every earlier release note pointing at nothing.
- **The audit actions.** `CHAT_GROUP_CREATED`, `CHAT_GROUP_MEMBER_ADDED`,
  `CHAT_GROUP_MEMBER_REMOVED` and `CHAT_MESSAGE_STRUCK` stay. The log is
  append-only and names acts as they were recorded, and a renamed action would
  make every earlier entry read as something other than what was written.
- **The record of processing activities.** Its `chat` and `newsComments` rows
  are the association's own record and keep their keys; the feed's sections of
  the access report map to them.

### What stays exactly as it was

- **Group visibility (ADR 0012).** The board reaches a group post only through a
  report from inside the group, and a report carries one post.
- **Styrelsen has no strike-through**, as the board chat had none.
- **The personal identity number check** on every piece of text a resident
  writes, the write budgets counted from the rows themselves, and no audit entry
  for writing a post or a comment in the feed (ADR 0010). The news screen's
  thread keeps writing `NEWS_COMMENT_POSTED` for a comment written there until
  the feed replaces that screen, because its connected-app actions publish that
  they do.

## Consequences

- **Stage by stage.** The change lands in five pull requests: this record, the
  schema, the migration and the API first; then the feed's screen; then the
  board's tools; then unread, must-read, editing and the issue report link; and
  last the moderation of Alla and a paged report queue. Until the second lands,
  the web client reads the new endpoints through the screens it already has.
- **A struck line in a group is a struck post.** The strike column, the report
  and the audit action are the ones the group chat had.
- **The administrator sees no feed.** That was true of every room before and
  stays true. The news screen's thread is still open to them under
  `news:comment` until the feed replaces it.
- **Likes are personal data.** Who liked what is on the access report, erased
  with the post and on request. The screen shows a count.
- **An erased post stays in the feed while it is answered.** A reader sees
  where a thread was and that its opening post is gone, rather than replies to
  nothing appearing from nowhere; the screen says the post was erased, and
  never attributes it to the board, which is who a post naming nobody otherwise
  speaks for.

## Revisit triggers

- **A cooperative asks for the board to see what Alla says before it is posted.**
  Pre-moderation is a different product and a different record.
- **The feed's poll stops being cheap.** One poll now covers every audience a
  person is in, so ADR 0010's own triggers apply to it directly.
- **Somebody asks for the names behind "Läst av" on an ordinary post.** That
  widens the purpose stated above, and needs a new balancing rather than a
  setting.
