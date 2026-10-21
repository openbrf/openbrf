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
there are four kinds:

- **Alla**: everybody who lives here, and everybody who holds a board seat that
  has not ended. The board is in it because it answers for what is written
  there and because what it posts as Styrelsen goes there.
- **Styrelsen**: whoever holds a board seat that has not ended. This is the
  board chat, unchanged in who is in it.
- **Each group**: whoever is written into it and still lives here. This is a
  group, unchanged in who is in it.
- **Administratörer**: whoever holds the administrator system role, and whoever
  holds a board seat that has not ended. Added with the board's tools
  (2026-10-19): the board writes to the people who run the instance, and hears
  back from them, in the feed rather than outside it.

An audience is a row (`audience`), and a group is an audience of kind `GROUP`.
Alla, Styrelsen and Administratörer are one row each, enforced by partial unique
indexes as the board chat was. The administrator holds every capability, holds
no seat and lives nowhere, so they are in no audience but Administratörer - the
one written to them - as they were in no room.

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
  clock is the only thing that removes a post. How the board moderates Alla is
  below, under "Moderation".
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

### Who writes as Styrelsen, and to whom

Added with the board's tools in the feed (2026-10-19).

- **A board seat that has not ended, and `site:manage`.** Both are asked on
  every write (`feed-board.ts`), the seat of the register rather than of a flag.
  The seat is who the house hears from when it hears from Styrelsen; the
  capability is what publishing in the association's name has always taken on
  the news screen, because a post written as Styrelsen can be mailed and put on
  the website. The administrator holds every capability and no seat, and does
  not speak for the board.
- **To Alla, Styrelsen or Administratörer.** "Till" offers the board those
  three whether it writes as Styrelsen or as its members, and a board member
  who lives here the group that is open as well - as themselves only: a group
  is not the board's to speak in (ADR 0012), and the server refuses a post or a
  comment written as Styrelsen there with `board-post-audience`.
- **One write, on the news module's own path.** A post written as Styrelsen is
  a news item, whatever its audience. The item is written with a title and the
  post's text as its paragraphs, and published in the transaction that writes
  the post, through the code the news screen's publish runs - so the mailing is
  claimed exactly once, and the audit log records the item's creation and
  publication as it records any other. The post carries the writer's choice of
  "via", and the board's flags: important, pinned, and whether it takes
  comments. Only the board pins, and only what the board wrote.
- **An item to Styrelsen or Administratörer is that audience's alone.** To
  Alla, the item is what the association says to the house: on the website for
  the members (or for anyone, when the board asks), on the news screen and in
  its thread, and mailed to the members. To Styrelsen or Administratörer it is
  read in the feed and nowhere else, on the feed's own audience check: on no
  website, not on the news screen, not in its thread and not in the connected
  apps' news actions, each of which answers it as an item that does not exist
  (`news-audience.ts`), because the administrator holds the capabilities those
  paths ask for and is not in Styrelsen. It cannot be shown on the website, and
  "Viktigt meddelande" mails the audience's own members, linking to the post in
  the feed rather than to an article the website does not have. The item says
  who it is for through its post, which is the one place a board post's
  audience is written.
- **Comments as Styrelsen name their writer.** Under a post in Alla, Styrelsen
  or Administratörer a board seat holder may answer as the board ("Styrelsen
  via ..."). A comment is one person's words on that person's clock, and its
  writer is who a report, an erasure request and an access report have to find,
  so a comment never hides who wrote it.
- **A scheduled post waits as a draft.** Its item is written unpublished and a
  job due at the instant publishes it, mailing and all, as if the board had
  pressed publish then (`news-schedule.service.ts`). Until then it is on no
  website, in no mailbox and in no feed but the board's, which lists it beside
  the feed rather than in it. Whatever publishes it first - the job, or a board
  member on the news screen ahead of the instant - is when the house hears it,
  and the post is stamped then. The job asks whether the item was ever
  published under the row lock its publish holds, so an item published by hand
  first, taken down again or removed leaves the job nothing to do.
- **The board can withdraw a scheduled post until it is published**, from the
  list beside the feed, whatever its audience. Added with the feed's additions
  (2026-10-20): a post to Styrelsen or Administratörer is on no news screen, so
  without this a post scheduled there could not be taken back at all. The item
  and its post are removed under the row lock the job's publish takes, so the
  two cannot cross: once it is published it is the house's, and is refused as
  no longer waiting. Like removing a draft on the news screen it leaves no
  audit entry, because nothing anybody could read stopped being published.

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
earlier. A board post appears only once its news item is published, and the job
that publishes it can run after its instant - a queue is not a clock - so the
item's first publication stamps the post again, on the feed's own rule and
never earlier than it was asked for: no cursor has passed its new place,
because nobody could read it before. `scheduledAt` records that it was
scheduled, which `createdAt` alone cannot say.

An open thread is delivered the same way, one level down: read from its newest
page, and polled forwards under its post from the newest comment the reader
holds, so a long exchange written while it was open arrives whole rather than as
its newest page. A comment is stamped later than every comment already under
its post, under a lock held per post, for the reason a post is stamped later
than every post in the feed: a cursor that has passed an instant must not have
a comment commit behind it.

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

"The board" here is whoever answers reports - `chat:moderate` and a board seat
that has not ended, asked of the register - and only in an audience they are
in. The list is of who is in the audience today, less the writer and less
everybody who has opened the post: a household that moved in after the notice
went up is on it, because the notice is still theirs to read. A person with
protected personal data is listed without a name, as an author is, and a
person whose processing is restricted (GDPR art. 18) is not listed, as such a
person is not mailed.

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
the latest text.

Written with the feed's additions (2026-10-20), on these terms:

- **Only what somebody wrote as themselves.** A post written as Styrelsen is a
  news item and is edited as one, on the news screen. A comment written as
  Styrelsen names its writer and is theirs to edit.
- **Not once the board has struck it.** A strike answers a report about what
  was said, and an edit afterwards would change what the board answered.
- **The same checks as writing.** The text is capped and scanned for a personal
  identity number exactly as a new post is, and the edit is not audited, for
  the reason a write is not (ADR 0010): the row and its history say it.
- **A bound on the history.** One post or comment keeps twenty earlier versions
  and refuses the edit after that. The history is personal data on the post's
  clock, and an unbounded one is a way to put a year of text on the disk
  behind a single post.
- **The earlier versions are the author's and the board's.** "The board" is
  whoever answers reports, as for the must-read list, and only where they may
  read the post. Everybody else reads what stands and that it was edited.
- **Delivered on the next read, not by the poll.** The poll asks what was
  written after a cursor, and an edit moves nothing in that order. Somebody
  with the post on screen reads the new text when they next read the feed or
  open the post, as they would read a strike.
- **On the access report**, beside the text it replaced, and erased with it.

### A post becomes an issue report

Added with the feed's additions (2026-10-20). The house reports faults where it
talks about them, and a post about the lift that is out is a fault report in
all but name. Its writer or the board can make it one ("Gör felanmälan"):

- **The issue report form, pre-filled.** The form opens with the post's text
  and its images, and the reporter edits it like any other report before it is
  sent. The images are uploaded again as the report's own photographs: from
  then on they are issue data, readable by the reporter and whoever handles
  issues and on the issue's clock, while the post's copies stay on the post's.
- **Linked once.** The report records the post it came from (`post.issueId`)
  in the transaction that files it, and a post leads to one report. Who may
  make it is asked again there: whoever wrote the post, or a board seat holder
  in its audience, holding `issues:report`. A group's post can only be made a
  report by somebody in the group.
- **The post shows where the report stands to whoever may read the report**:
  its reporter, and whoever handles issues. A post does not widen the report's
  readers, so a neighbour sees the post and not that a report was made from it.
- **Each goes on its own clock.** An issue purged first leaves the post
  standing without the link; a post erased first takes the link with its text,
  and the report stands.

### Unread, live

Added with the feed's additions (2026-10-20). The read marker (`audience_read`)
is what "unread" is counted from, and two things read it:

- **The navigation's count** of posts unread across every audience the reader
  is in, on every screen that carries the navigation.
- **A sign on each post in the feed that is new since the last visit**, taken
  from the markers as they stood when the feed was drawn, because the screen
  moves the marker forwards as soon as it shows the newest post. A sign on the
  post rather than one line between the new and the read, because the pinned
  posts sit on top whatever their age: a line under a post that arrived today
  would also call new a pin read long ago.

Both follow the poll (ADR 0010), for every audience at once rather than the one
that is open: on the feed, the list of audiences is read again on the feed's
own four-second poll, and everywhere else the navigation reads it every thirty
seconds. Thirty, because a count in the band is a nudge rather than a
conversation, and a screen left open on the overview should cost the server a
fraction of what an open feed does. Both pause while the tab is hidden, and the
two share one answer and one request at a time.

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
- **Withheld with the text.** When the board strikes a post through, its images
  are withheld from the audience with the text, and stay visible to the author
  and the board.
- **Erased with the post.** The purge removes the files when it deletes or
  erases the post, on the post's own date. An upload that was never put on a
  post is removed two days later; the one-day limit on attaching it is what
  keeps a post from being written with a file the purge is removing. Neither
  removal touches a file whose uploader is under a legal hold or a restriction
  of processing: the purge asks again under the uploader's legal hold key, on
  the transaction that deletes the file's row, and the bytes leave storage
  only after it commits.
- **On the access report as a count**, as an issue's photographs are.

### Moderation

Added with the moderation of Alla (2026-10-21). The board answers for what is
said in Alla and in a group, and it does so the same way in both: it strikes a
post or a comment through, which withholds the text (and a post's images) from
the rest of the audience and from nobody else - the writer and the board still
read it, it stays where it is under the same name, and the retention clock is
unchanged. Nothing clears a strike, and nothing here erases anything. What
differs between the two is how the board gets there.

- **In Alla the board strikes without a report.** The board is in Alla, reads
  everything said there and answers for it, so a board member strikes a
  resident's post or a comment under any post in Alla from the feed itself,
  under the board's sign and after one more question, because a strike cannot
  be taken back. A neighbour can report a post or a comment in Alla too ("Anmäl
  till styrelsen"), which asks the board to look; the board is offered the
  strike there instead of the report, since a report from the board would be to
  itself.
- **In a group the board acts only on a report.** A group's post or comment
  reaches the board when somebody in the group reports it, and the report
  carries that one thing and nothing else (ADR 0012). A report of a comment
  carries the comment alone: not the post it answers, and not an address the
  board could follow to it. A board member who is in the group is a member
  there, and is refused a strike without a report like any other board member.
- **Not in Styrelsen or Administratörer.** Neither has a strike-through and
  nothing in either can be reported, as the board chat had none: the board is
  the whole of the one and half of the other, and a board able to strike a
  colleague's line would be deciding what the record of its own deliberation
  says.
- **Not a post written as Styrelsen.** It is a news item, which the board takes
  down or edits on the news screen; a comment under it is a resident's and is
  moderated like any other comment in Alla.
- **"The board" is whoever answers reports**: `chat:moderate` and a board seat
  that has not ended, asked of the register on every act. The administrator
  holds the capability and no seat, is in neither Alla nor any group, and is
  answered as for a post that does not exist.
- **A report carries a post or a comment, and goes with it.** The row names
  exactly one of the two, which a check constraint holds. A report of a post is
  erased with the post; a report of a comment is erased with the comment, on
  its writer's clock, and stands when the post above it is erased on another
  writer's. One person reports one post once and one comment once, and makes
  ten reports in an hour at most: the one-report rule bounds nothing about one
  person, and every comment in Alla would otherwise be a row one reader could
  put in the board's queue.
- **Nobody reports their own words**, and the board does not report what is
  said in Alla, where it strikes instead. The feed offers the report by the
  same rule the server refuses it by (`post-report-access.ts`), and a reader
  who already holds a report of something is not offered another.
- **Recorded as before.** A strike writes `CHAT_MESSAGE_STRUCK`, with the
  writer as its subject and the audience and never the text in its context:
  `chatMessage` as the target kind for a post, as every earlier strike reads,
  and `postComment` for a comment, which is the same act one level down. A
  report and a dismissal write no audit entry; the report row is the record.
- **Every strike answers every open report of what it struck**, whichever way
  the board got there, so a report the board settled from the feed leaves the
  queue as upheld.

The queue is read a page at a time, oldest first, and paged forwards on
`(createdAt, id)` with the feed's own cursor, written out so a report answered
or erased between two pages does not lose the board its place. Before this,
the queue answered its first fifty open reports and nothing past them could be
reached.

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
  `chat:moderate` the report queue and the board's strike-through. A
  capability's name is a published part of the authorization model - the
  release notes name these two, and a reviewer reads the role grants by them -
  and what each one guards is what it guarded: the first is every resident's
  and every board member's way in, the second the board's moderation of what
  the house writes, which in the chat was its answer to a report and now
  reaches Alla too. A new name would say the same thing in a new word, and
  leave every earlier release note pointing at nothing.
- **The audit actions.** `CHAT_GROUP_CREATED`, `CHAT_GROUP_MEMBER_ADDED`,
  `CHAT_GROUP_MEMBER_REMOVED` and `CHAT_MESSAGE_STRUCK` stay. The log is
  append-only and names acts as they were recorded, and a renamed action would
  make every earlier entry read as something other than what was written.
- **The record of processing activities.** Its `chat` and `newsComments` rows
  are the association's own record and keep their keys; the feed's sections of
  the access report map to them.

### What stays exactly as it was

- **Group visibility (ADR 0012).** The board reaches a group's post or comment
  only through a report from inside the group, and a report carries one post or
  one comment.
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
  and the audit action are the ones the group chat had, and a struck comment
  under a notice is the same strike on the same comment row.
- **The administrator sees one audience.** They were in no room before, and
  are in Administratörer alone: what the board writes to them, and what they
  answer. The news screen's thread is still open to them under `news:comment`
  until the feed replaces it, and shows only the house's items.
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
