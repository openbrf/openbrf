# @openbrf/api

## 0.4.0

### Minor Changes

- b6d0def: A plugin can now hand the board a member list to review, such as one emailed
  to the association (ADR 0043). It asks for the new permission
  `addressBook:proposeImport` and calls `host.imports.propose` with the file, CSV
  or XLSX, and, when its source has one, who sent it. The core reads the file
  exactly as it reads an upload and holds it as an import proposal. Nothing is
  written to the register until a board member has previewed and applied it on
  the import screen. A plugin cannot read the register through this permission,
  and it is told only the receipt, why a file was refused, and where its own
  proposals stand (`host.imports.status`). It can take one back with
  `host.imports.withdraw`.

  Proposals wait at the top of the import screen as "Proposed by" the plugin,
  with the file name, the row count, when the file arrived and the sender as the
  plugin reported it, and in the board's "To handle" queue on the overview. A
  board member opens one at the mapping step, with the mapping saved for that
  plugin's files when the column titles are the same, or rejects it. A plugin has
  one proposal waiting at a time: a newer file supersedes the one before, and a
  file holding the rows of the one waiting, or of the last one the board applied
  from it, is refused as unchanged. A proposal nobody decides expires after 14
  days. Decided proposals are listed below the waiting ones, and each record is
  deleted 90 days after it was decided. The audit log records that a plugin
  proposed a list, and that a board member rejected one, without the file name or
  the sender.

  Every import, uploaded or proposed, now deletes the rows of its file, its
  preview and the board's decisions as soon as it has been applied or has
  stopped, rather than keeping them until the upload expires.

  A plugin that declares `addressBook:proposeImport` must declare the personal
  data categories `name`, `apartment`, `residency`, `email`, `phone`,
  `personalIdentityNumber` and `protected`, because the list it carries can hold
  all of them. The last two are new to a plugin's declaration and are refused
  without the permission. `protected` is also a category the association's record
  of processing activities can now name. The permission cannot be combined with
  `site:blocks` or with a device route. The install consent now asks whether a
  plugin sends personal data outside the instance or receives it from outside.

  The first release with this change is the minimum host release for a plugin
  that proposes imports: an older host refuses the permission in the manifest.

- db7ea73: Hold a paid plugin's licence issuer and keys to the board's consent at start
  (ADR 0042).

  The instance now records the issuer and the fingerprint of each issuer key of
  the catalog entry the board installed a paid plugin from. At start it refuses a
  version that declares a key outside those, as `licence-widened`, and a version
  that names another issuer or no longer declares a consented key, with the new
  finding `licence-issuer-changed`. Such a package could otherwise read another
  issuer's licence for the same entitlement. The plugin loads again once the
  board installs it again from the catalog. The gate refuses only a package that
  disagrees with the catalog entry installed, so a rotation the catalog publishes
  in one release, which the board installs, passes. A package refused over its
  issuer or keys keeps no manifest, even if it is also disabled or refused for another reason, so its keys verify no licence, on the
  licence screen or from the command line.

- 920a721: The AI package can now propose a general meeting's agenda. The board member who
  asked for it confirms the proposal before anything is written. The proposal
  replaces the whole agenda and names the agenda it was drafted against, so a
  proposal confirmed after somebody rewrote the agenda is refused as out of date
  instead of overwriting the newer agenda. The agenda cannot be changed once the
  notice has been issued or the meeting has been recorded as held. The confirmed
  change is recorded as the confirming board member's own, made on the web, and
  its audit entry names the proposal that led to it. The board's own meetings
  screen writes the agenda as before.
- 920a721: A connected app can read the association's general meetings for the board.
  `meeting_list` lists the meetings with their day, kind, whether the notice has
  been issued and the number of agenda items. `meeting_get` reads one meeting
  with its agenda, the outcome and vote totals of each decision, and the time and
  place in its notice. Both need `meetings:manage` and are offered on `mcp` and
  `ai`. Neither returns who attended, the proxy authorisations, the voting
  register, individual votes or which members the notice did not reach. ADR 0041
  records the decision, including the document reads that follow in a separate
  change.
- 5c47170: Put a page in the menu with one switch, and arrange the menu by dragging.

  Every page in the website's page list, the association's own and the built-in
  ones, has a "Show in menu" switch. Turning it on adds an entry last on the top
  level of the menu with the page's title as its text; turning it off takes the
  page's entries out of the menu, and what hung under one stands in its place.
  The switch acts at once and needs no save. A visitor sees the entry once the
  page is open to them, as for any entry.

  The menu screen is arranged by dragging. An entry is dragged up or down to move
  it, and sideways under the entry above it to make it a dropdown item; the menu
  keeps its two levels. Each row has the same moves as buttons - up, down, into
  the dropdown above and out of it - which is what a keyboard and a screen reader
  use, and the screen says in the board's language where the entry went. An entry
  whose form is open can be moved, and keeps the changes not yet saved. While an
  entry is being removed, it and what hangs under it stay where they are and
  nothing can be moved in under it, so the removal takes the dropdown the board
  saw when they removed the entry. Pages
  that are not in the menu yet are listed under "Add a page", one button each,
  and the form below it is for a link to an address elsewhere.

  For API clients: `POST /api/site/pages/:id/menu` with `{ "inMenu": boolean }`
  puts a page in the menu or takes it out and answers with the page, which now
  carries `inMenu`. `POST /api/site/menu/arrange` takes the whole menu in reading
  order, each entry with the top-level entry it hangs under, and writes both
  levels in one step. It is refused with `menu-changed` when the menu no longer
  has the entries it was sent, and with `nesting-too-deep` for a third level.

### Patch Changes

- dd7a258: Verify a licence only with an issuer key the board consented to (ADR 0042).

  The licence screen and `openbrf licence` now count a plugin only while its
  consent record holds its licence declaration by the boot gate's test: the
  consented entitlement and issuer, and each declared key among the consented
  ones. They read that consent each time they list the licences, and again when
  they store what a key verified, in the same transaction and under a lock that
  an update or removal of the consent waits for. Before, the server tried the
  keys of every manifest its last start kept, so after the board consented to an
  update with other keys, or removed the plugin, the old key still verified a
  licence until the next start: the screen showed it as verified, and the audit
  log recorded it as verified with that issuer. Such a key now verifies nothing,
  a licence entered with it stays not yet checked, a licence it verified earlier
  shows its issuer as not installed, and the plugin is no longer listed with an
  entitlement state on the licence screen.

- e2cf28b: A plugin's writes to `host.records` that wait their turn are now held to 100 per
  plugin, the one under way and those waiting. A write sent past that throws
  `PluginRecordLimitError` with the `limit` `queuedWrites`, and nothing is
  written, so a plugin that writes faster than the database lands them can no
  longer grow the instance's memory without bound.

  The refusal shown when a catalog entry names another package under the id of an
  installed plugin now calls what is deleted with the plugin its settings and
  configuration records, as the remove screen does. The plugin contract also tells
  whoever curates a catalog that a package renamed under an existing id strands
  the instances that run it, and that it should take a new id instead.

- 18f2a00: Removing a plugin now deletes its job queues as well: the jobs waiting on them,
  the finance events not yet handed to it, its cron schedules, and their
  occurrences not yet sent to it. A job the plugin was still sending as it was
  removed goes with them: the removal waits for that send to finish before it
  deletes anything. Before, they stayed in the job schema, a schedule went on
  adding jobs that nothing worked, and a plugin installed later under the same id
  was handed all of them. Where the deletion fails, the next
  install under the id deletes them before it writes anything, and refuses while
  it cannot; that install also clears what removals made before this release left
  behind. A cron occurrence the removed plugin's schedule was already sending
  never reaches the next plugin's handler: a job a cron schedule sends is now
  handed only to the queue that schedule was made for, not to a queue made again
  under the same name. That holds for a schedule an earlier release made as well:
  each start gives such a schedule the queue it belongs to before its first cron
  pass. No deploy step is needed beyond the usual order of stopping the old
  release before the new one starts: a host still on an earlier release would
  hand its handlers a cron schedule's data together with the queue it was made
  for, rather than the data alone.
- Updated dependencies [b6d0def]
- Updated dependencies [db7ea73]
- Updated dependencies [920a721]
- Updated dependencies [920a721]
- Updated dependencies [5c47170]
- Updated dependencies [e2cf28b]
- Updated dependencies [5c47170]
  - @openbrf/plugin-sdk@1.2.0
  - @openbrf/i18n@0.4.0
  - @openbrf/shared@0.4.0

## 0.3.0

### Minor Changes

- e511e0e: `host.actions.list` hands a plugin each listed action's input and output JSON
  Schema, `inputSchema` and `outputSchema`, as the HTTP catalogue publishes them
  for one action (ADR 0038). A connector can build `tools/list`, and an AI package
  can describe a tool to a model, without calling its own instance over HTTP.
  Only the actions listed carry one, filtered by channel, surface, capability,
  liveness and arming, as `invoke` is. Token scope and read-only mode are decided
  at `invoke`, which may still refuse a listed action. The SDK exports the entry's type as
  `ActionWithSchemas`.
- e511e0e: A plugin can declare that it is an AI package, `ai: true` in its manifest,
  when a language model chooses the actions it dispatches (ADR 0038). What it
  changes for a signed-in person is recorded in the audit log on the `ai`
  channel rather than as any plugin's. It reaches only the actions offered on
  the `ai` surface, and a plugin's action, its own included, only once an
  administrator has armed it. A connected app's token on its route is still
  recorded as the connected app. The plugin cannot choose its channel: the
  host derives it from the manifest and from how the request arrived, as the
  authorization guard established it, so writing a token onto the request, or
  removing or changing one, moves no plugin's dispatch onto another channel.

  The catalog entry repeats the declaration. The consent screen and the
  command-line install state it, and an install whose screen showed otherwise
  is refused. The board's consent is recorded, on the install row and on its
  `PLUGIN_INSTALLED` audit entry, and a package whose manifest
  says otherwise is not loaded and is listed as `ai-changed`. No core action is
  offered on `ai` yet.

- 3b2a3e3: The apartment register now records what bostadsrättslagen 9 kap. 10 § lists
  for each apartment and it lacked: the number of rooms, the other spaces the
  tenant-ownership covers, and the day Bolagsverket registered the economic plan
  the apartment was granted under. The living area is recorded beside them, for
  the broker's description of the apartment. The board records all four for
  every apartment in one form on the apartment register, and each change is
  written to the audit log, which names the fields and not their values. The form
  sends only the apartments the board member changed. If another board member's
  save has changed one of them since the form was opened and the values submitted
  would change what they saved, the whole save is refused and nothing in it is
  written, so an older form cannot undo a newer correction.

  The register and every extract show them, the tenant-owner's own extract
  included, since 9 kap. 11 § makes that extract cover every field 10 § lists. The
  initial supply file gains a column, `apartmentOtherSpaces`, which answers
  whether land and other spaces are included in the grant (Förordning (2026:898)
  2 kap. 3 § första stycket 6) with the register's description of them.

  Existing apartments show the new fields as not recorded until the board fills
  them in. The migration adds nullable columns and needs no manual step.

- 55d2030: An audit entry written by a plugin's dispatch now names the plugin. When a
  plugin's route dispatches an action, the entry records the plugin's id beside
  the person and the channel, whatever the channel is. A signed-in person's
  request on the plugin's route is recorded on the `plugin` channel, or on `ai`
  when the plugin is an AI package. A connected
  app's token on that route is recorded on `mcp`, and the entry now names both the
  app and the plugin. The host supplies the id from the plugin's manifest, so a
  plugin cannot name another plugin. The entries for a plugin's delivery receipt,
  for a theme a plugin installs, for a device token a plugin issues or revokes,
  for a secret setting a plugin writes, for a disclosure to a plugin's declared
  recipient, and for a change a plugin's route proposes name the plugin the same
  way.

  The data subject access report prints the plugin under the channel in its
  "Through" column. A `plugin` or `ai` entry written before this change says that the
  plugin was not recorded at the time.

  The SDK's `ActionContext` gains an optional `pluginId`, so an action's handler
  can tell when a plugin's route made the call. One migration adds a nullable
  column to the audit log. It has no default and fills in no older rows.

- c198a01: List the news, the calendar, the broker information page and the account
  request form as built-in pages, and put them in the menu the way any page is.

  The website's page list now shows the four built-in pages beside the
  association's own, marked as built in. Opening one shows what stands on it,
  lets the board rename it, and links to where its content is written: the news
  screen, the events, or the account request setting. The broker information
  page's own panel is where the association facts it is made from are recorded.
  What stands on a built-in page stays the platform's, its address does not
  change, and it is always public.

  Adding a menu entry no longer has a separate choice for a generated page. The
  built-in pages are among the pages to choose from, and an entry left without a
  label takes the page's title. An entry can be kept for signed-in members with
  "Only for signed-in members", whatever it leads to. Every menu keeps its
  entries, their labels, their places and whom they are shown to when you
  upgrade, and the website's addresses stay the same. A button chooses a
  built-in page from the same list of pages, by the title the board gave it; the
  account request form is not offered to a button.

  For API clients: a menu entry's `kind` is `PAGE` or `EXTERNAL`, and
  `generatedKey` is gone; an entry for a built-in page is a `PAGE` entry with the
  page's id, and every entry carries `membersOnly`, which a change that leaves
  it out keeps as it was. Every page carries `builtIn` (`NEWS`, `CALENDAR`,
  `BROKER_INFORMATION`, `REQUEST_ACCOUNT` or `null`). A built-in page takes a new
  title and nothing else: a body, another address, another status, the front
  page and a delete are refused with `built-in`. The `menu_generated_keys`
  action is retired; `page_list` finds the built-in pages. A button block names
  a built-in page the same way, as `{ "kind": "page", "pageId": ... }` with the
  page's id, and has no other kind of destination for one. ADR 0027 records the
  model.

- fc579e0: An instance now reads the curated catalog at its version 2 address,
  `https://raw.githubusercontent.com/openbrf/catalog/main/catalog-v2.json`, where
  it used to read `catalog.json`. Version 2 lists the plugins and themes that need
  the fields added in index version 2, which an instance that reads version 1
  could not offer. An instance with `OPENBRF_CATALOG_URL` empty needs no
  configuration change. An instance that wrote the old curated address into
  `OPENBRF_CATALOG_URL` now has an address that is not the curated one: it is
  refused unless `OPENBRF_UNCURATED_PLUGINS_ENABLED` is set, so empty the variable.
- 10d3aa4: A connected app can read the association's document archive for the person
  who connected it. `document_list` lists the documents that person may read,
  with search on the title and the binder. `document_get` reads the text of up to
  ten pages of one document's PDF, and each answer names the page and the
  character the next read starts from, so a long document, or a page longer than
  one answer holds, is read in turns with nothing skipped. Both follow the
  archive's own rule: the public shelf for anyone, and the members' shelf for a
  member or the board. The board's own shelf is not offered. Both are offered on
  `mcp` and `ai`.

  The text is extracted when it is asked for and is not stored. Mozilla's pdf.js
  does the extraction in a separate Node process of its own, with no environment,
  no file access outside pdf.js and no right to start processes or threads, under
  caps on the file size, the number of pages, the amount of text, the time and the
  process's memory. The API watches the process's memory, as the operating system
  counts it, and stops the process that passes the cap or the time, or whose
  memory it repeatedly fails to read; where the system does not report it, the
  process's own watch and heap cap remain. A read whose answer from the process is
  not what the API expects is refused as unreadable. At most two reads run at
  once, and a read past them is refused before its file is opened.
  A scanned PDF is answered as having no text layer, and there is no OCR.

- cbb9891: The feed does four things a noticeboard does not (ADR 0026).

  **Unread, live.** The feed's entry in the navigation shows how many posts are
  unread across every audience you are in. On the feed, each post that is new
  since your last visit is marked new, pinned or not. Every audience's count
  refreshes with the feed's poll, not only the open one's, and the navigation's
  every thirty seconds on every other screen. Both pause while the tab is hidden.

  **A post becomes an issue report.** On a post you wrote, or as a board member on
  any post you can read, reporting an issue from the post opens the issue report
  form filled in with the post's text and images. Sending it links the report to the post, and
  the post then shows where the report stands. Only the report's reporter and
  whoever handles issues see that; the post does not show it to anybody else.

  **Must-read.** On a post the board marked important, the board can list who in
  the audience has not opened it yet, leaving out anyone whose processing is
  restricted. Everybody else sees the count, as before.

  **Edit with history.** You can edit your own post or comment, which is then
  marked as edited. You and the board can read the earlier versions; nobody else can.
  A post the board struck through can no longer be edited, and one post or
  comment keeps twenty earlier versions. The earlier versions are on your access
  report and are erased with the post.

  The board can also withdraw a post it scheduled, from the list of scheduled
  posts, until it is published. That includes a post scheduled for the board's or
  the administrators' audience, which the news screen does not list.

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

- a9f6b95: The board writes in the feed as Styrelsen (ADR 0026). In "Write a post", a
  board seat holder chooses "From": themselves, "Styrelsen", or "Styrelsen via"
  their own name. They also choose "To": Alla, Styrelsen or Administratörer,
  and, writing as themselves, the group that is open.

  Administratörer is a new audience in the feed: the instance's administrators
  and the board. It is the one audience the administrator is in, so the board can
  write to the people who run the instance and hear back from them.

  A post written as Styrelsen is a news item, and takes a title as well as its
  text. It is written and published in one act, through the news screen's own
  path and with the same audit entries. Written to Alla, it is published to the
  members on the website and in the news reader. Written to Styrelsen or
  Administratörer, only that audience reads it, in the feed: it is not on the
  website, the news screen or the news thread. The board's options come with it:

  - "Important message" sends the news mailing, exactly once. It goes to the
    members for a post to Alla, and to the audience alone for any other, with a
    link to the post in the feed.
  - "Pin to the top" pins it on top of the feed.
  - "Allow comments" (on unless unticked) decides whether it takes comments.
  - "Show on the association's website to everyone" publishes a post to Alla to the
    street.
  - "Schedule publication" holds it for an instant ahead.
  - "Preview" shows it as it will read, from Styrelsen.

  A scheduled post waits as a draft that only the board sees, listed beside the
  feed under "Scheduled posts". A job publishes it, mailing included, at its
  instant. It reaches every open feed with the next poll, even when the job runs a
  moment late. A post to Alla can be changed or removed on the news screen before
  then, as any draft can. If a board member publishes it there first, it appears
  in the feed at once, and the job does nothing when its instant comes.

  Under a post to Alla, Styrelsen or Administratörer, a board seat holder can
  answer as "Styrelsen via" themselves; the comment still names its writer. The
  news screen's thread reads such a comment as "Styrelsen via" its writer too. The
  board pins and unpins its own posts with the controls marked Styrelsen on the
  card.

  Only a board seat that has not ended speaks for the board. The server refuses
  every one of these to a resident and to the administrator, whatever a screen
  sends. It also refuses:

  - a post or comment written as Styrelsen into a group;
  - the website for a post anywhere but Alla;
  - an ordinary post carrying the board's options.

  API changes:

  - New endpoints: `POST /api/feed/board-posts`, and `PUT` and `DELETE
/api/feed/posts/<post>/pin`.
  - `POST /api/feed/posts/<post>/comments` takes `asBoard`, and `POST
/api/feed/posts` now refuses fields it does not know.
  - `GET /api/feed/audiences` answers `mayPostAsBoard` and may list an audience
    of kind `ADMIN`.
  - `GET /api/feed/posts` answers `scheduled`, and a post's news item carries its
    `text`.
  - A news comment, from `GET /api/news-comments/<news>` and the
    `news_comment_list` and `news_comment_hide` actions, carries `byBoard`.

- e5ac99f: The board moderates what the house writes in Alla, and its report queue reaches
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
  they strike instead, and one person can make ten reports in an hour. A post or a
  comment the reader has already reported is no longer offered for reporting, also
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

- c46aeff: Turn the chat into a feed underneath: one stream of posts and comments for the
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

- 69cc696: The feed gets its own screen, at /app/feed, in place of the chat (ADR 0026).
  /app/chat now goes to the feed, and "Chat" in the navigation is "Feed".

  Posts are newest first with the pinned ones on top. Each one shows who wrote
  it - "Styrelsen", or "Styrelsen via" its writer - when, and to which audience,
  with the text as it was written, its line breaks kept and its web addresses
  made into links, and the images on it. Under it are "Like" with a count, the
  comments, which open under the post, flat and oldest first with likes of their
  own, and "Read by N": how many have had the post on their screen, as a count and
  never as names. The ⋯ beside a post copies its text, and in a group reports it
  to the board. Nothing deletes a post: the board strikes through.

  "Write a post..." opens the composer. A resident writes as themselves, to
  Alla from the whole feed or to the group or Styrelsen that is open. The text is
  required, and up to four images can be attached; they are uploaded as they are
  picked and the post is written once with them. "Preview" shows the post
  before it is created.

  The search field and "Filter posts" - the board's posts, the neighbours',
  important ones only - narrow the feed inside the reader's own audiences and
  never outside them. The panel beside the feed lists Alla, Styrelsen and each
  group with what is unread in it, and keeps making a group, putting a neighbour
  in and leaving one.

  Every post has an address of its own, /app/feed/<post>, which opens the post
  with its comments: what a news mailing, a report or an issue report can link
  to. A post in a group the reader is not in is refused there exactly as one that
  does not exist.

  Images on a post are stored like every other upload - identified from their
  own bytes and encrypted at rest - and served only to whoever may read the post,
  and not to the group when the board has struck the post through. The board
  sees a reported group post's images in the report queue, and is served them
  through the open report alone; each such serve is written to the audit log.
  They are erased with the post, an image uploaded for a post that was never
  written is removed after two days unless a legal hold or a restriction of
  processing stands over the person who uploaded it, and the access report counts
  the images on each of the person's own posts. New endpoint: `POST
/api/feed/images`; `POST /api/feed/posts` takes `imageIds`.

  An open thread receives the comments its neighbours write while it is open:
  it polls forwards from the newest comment it holds, paused while the tab is
  hidden, and after the reader writes it reads everything written since, however
  many pages that is. New endpoint: `GET
/api/feed/posts/<post>/comments/since?after=<cursor>`. A comment the board has
  struck through now says so in its own words rather than the post's.

- 3a6bf92: Verify a licence for a paid plugin on the instance, offline (ADR 0042). Each
  instance now has an id and an Ed25519 instance key, created at first start,
  with the private key encrypted under the field-encryption key. An operator
  enters a licence file with `openbrf licence add`, or the board through
  `/api/licences`, and the host checks it against the keys the plugin's manifest
  declares in its new `licence` field, and the instance's own id and key, on the
  association's calendar day. A licensed plugin reads the result through
  `host.entitlements`: active, or absent, expired, version not covered, wrong
  instance, tampered or not yet valid, and can present the licence to its
  issuer's service with the instance's signature. Nothing in the core depends on
  a licence, and entering, verifying and removing one is written to the audit
  log. After the instance key leaked, an operator replaces it with
  `openbrf licence replace-key "<reason>" [--new-id]`, which is audited and leaves
  every licence issued to the old key wrong-instance until it is reissued. The
  SDK adds `createTestEntitlements` for a plugin's own tests.
- 101cee1: Add the licence screen, and make a paid plugin's licence part of what the board
  consents to (ADR 0042).

  - **Licence screen.** At `/licences`, for the administrator who installs
    plugins (`association:manage`). It shows the instance line to give the issuer
    when ordering a licence, and each licence entered with its check: verified,
    not yet checked, changed since it was entered, or its issuer's plugin no
    longer installed. It also shows what each licensed plugin finds today. The
    administrator enters a licence by choosing the file or pasting it, and
    removes one. From thirty days before a licence's last day the screen says when
    it ends, and it says when the instance key cannot be read, as after a restore
    under another encryption key. A support session reads the screen and changes
    nothing.
  - **Consent to a licence.** A catalog entry now repeats a plugin's `licence`
    and `released`. The consent screen says that the plugin needs a licence from
    its issuer and does nothing without one, and names each service it may show
    the licence to. The install request echoes the declaration back. The instance
    records the entitlement and the services the board consented to, and refuses
    at start, with the new finding `licence-widened`, a version that reads another
    entitlement or names another service. The catalog marks a plugin that needs a
    licence.
  - **Updates the licence does not cover.** When a release is published after
    the last release the licence held covers, the update screen says so before
    the board updates, and the command-line tool prints the same notice.

  A licensed plugin installed before this release has no recorded consent to its
  licence and is refused as `licence-widened` until it is installed again from
  the catalog.

- f51309d: Add a management API for whoever hosts an instance. It is off unless the
  operator configures a port and a token, answers on that port only, never on the
  public address, and returns one summary: the number of apartments, how many
  people the registers hold, whether residents have been invited, the day the
  board was last active, how often the register extracts have been generated,
  storage used, the running version and the state of the database migrations. It
  carries nothing about any one person. The instance keeps only a digest of the
  token, and every read is written to the audit log under a channel of its own.
- 039e65c: Add four layout blocks to the association's website: a banner, columns, a
  button, and a picture beside text.

  - **Banner**: a large picture with a heading, an optional short text and an
    optional button. The words stand on the theme's surface under the picture,
    so their contrast does not depend on the photograph.
  - **Columns**: two or three columns side by side, one under the other on a
    narrow screen. A column holds paragraphs, headings, pictures and buttons, and
    never columns or another layout block.
  - **Button**: a call to action leading to one of the association's pages, the
    news, the calendar or the broker information page, or an https address, in a
    prominent or a subtle style. A button to a page a reader may not open - a
    draft, a page for the members, a deleted page - is not shown to that reader.
  - **Picture beside text**: a picture on the left or the right of the board's
    own text, above it on a telephone.

  A banner's picture and a picture beside text must be described. Every picture
  in a banner, beside text or inside a column is checked for a public file and a
  confirmed publication consent like a picture block, and every word and address
  on them is scanned for personal identity numbers. The page editor offers all
  four with fields that work from the keyboard and with a screen reader. Stored
  pages are unchanged.

- e4cf311: Give a page on the association's website one status, let the board choose the
  front page, and make a page's address from its title.

  A page is now a draft, members only or public, chosen in one place in the page
  editor and written when the page is saved. It replaces the published flag and
  the visibility beside it. The upgrade keeps who can read every page: a published
  public page is public, a published members' page is members only, and an
  unpublished page is a draft. When it was first published is kept.

  The front page is chosen with "Use as front page" on a public page, and
  arranging the menu no longer changes it. There is one front page at a time, and
  choosing another replaces it. The front page cannot be made a draft, made
  members only or deleted until another page is chosen. The upgrade chooses the
  page the website's address served the day before, so an upgraded site looks the
  same. An instance with no public page has no front page, and its address
  answers as it did.

  A new page needs only a title. Its address is made from the title, with å, ä
  and ö read as a, a and o and a number added when another page has it, and moves
  with the title until the page is first published. The address can be written by
  hand under "Advanced" in the page editor. Every page that exists when you
  upgrade keeps its address.

  For API clients: `POST /api/site/pages/:id/publish` and `/visibility` are
  replaced by `/status` (`{ "status": "DRAFT" | "MEMBERS_ONLY" | "PUBLIC" }`), and
  `/front-page` chooses the front page. A page carries `status`, `frontPage` and
  `slugFollowsTitle` in place of `published` and `visibility`, and `slug` is
  optional when a page is created or saved. The actions `page_set_status` and
  `page_set_front_page` are new; `page_publish` and `page_set_visibility` are
  deprecated aliases of `page_set_status`, which refuses their old input with the
  schema it takes instead. `page_create` still accepts `visibility`, deprecated
  and ignored, and makes a draft. ADR 0027 records the model.

- 4ced8ff: Add pending changes: a call to an action held as a preview until the person it
  was proposed as confirms or rejects it on a screen of the platform's own, at
  `/app/pending-changes`. A plugin proposes one with `host.actions.propose`, which
  checks the call as `invoke` would and runs nothing; confirming runs it as the
  person confirming, with what they may do at that moment, and every check made
  again, including the arming of a plugin's action proposed through a connected
  app. A change is claimed before its action runs, so it never runs twice. Only the
  proposer can see or act on a change, and it lapses after a week.
  A write on the `ai` channel is refused with `confirmation-required` and has to be
  proposed. Proposing, confirming, rejecting and expiry are each recorded in the
  audit log, and the entry of the action the change held names the pending change;
  a write that action makes through `host.actions.invoke` is the plugin's own and
  does not. See ADR 0039.
- 4f60b06: `host.actions.client(request)` tells a plugin which connected app a request on
  its route was authenticated with, or `null` for a signed-in session. It answers
  from what the host established when it authenticated the request, as the
  dispatch does, so writing a `token` on the request or removing it does not
  change the answer. A connector uses it to refuse a request that did not come
  from a connected app, without reading the request's own properties.
- a050e5b: A plugin can now serve a screen in the stairwell, or any other device nobody
  signs in to, without borrowing a person's session and without a public route
  (ADR 0031).

  A manifest declares `deviceRoutes`: paths under the plugin's own mount that
  answer `GET` and `HEAD` to a device token and to nothing else. The plugin issues
  a token through `host.devices`, only on a request from a board member who manages
  the website, and the token reaches that one route of that one plugin. It is
  stored as a digest, rate limited, and revoked at once from the plugin or from the
  new Devices screen, where the board sees every live token on the instance and
  when it was last used. A plugin with a device route may not read the address
  book or the finances. `@Public()` on a plugin route still has no effect.

  Device routes, and every path the board consented to as one that a later
  version dropped or moved, are the only place the API sends CORS headers, so a
  player packaged as a TV app can read them, the refusal that says its token is
  gone included.
  `OPENBRF_DEVICE_TOKEN_CALLS_PER_MINUTE` (default 120) bounds what one device may
  spend.

  The catalog index gains version 2, which adds `deviceRoutes` to a plugin entry.
  This instance reads versions 1 and 2. A version that adds or moves a device
  route is held as `device-routes-widened` until the board consents again, and
  one that drops a route revokes the tokens issued for it.

- 4135ce7: A plugin can now read the association's fee notices and charges, record where
  it delivered one, and hear when one is issued or changed, through
  `host.finances`. This is the free part of advanced finances: what carries a
  notice or a charge into an accounting system or a bankgiro file is a plugin's
  own work, and it now has a public API to do it on.

  - Reading the finances covers the fee notification runs and their notices and the
    charges to members, masked as the files the board hands over and further: a
    person with protected personal data, or whose processing is restricted, is
    never named to a plugin, and a withheld value is a `withheld` branch rather
    than an empty string. The board's reason for a charge is withheld wherever
    such a person lived in the household charged on the day of the charge. No
    read carries a personal identity number or any payment state.
  - A separate permission lets a plugin record a delivery receipt - the route, the time
    and the receiving system's reference - against a notice or a charge. It is
    never a paid flag, it is audited, and the board sees receipts beside each
    notice on screen; they are not printed and not in the file. A plugin's read
    withholds a receipt's reference wherever the row's names are withheld, and
    on every receipt another plugin recorded. The data subject access report
    lists a notice's or a charge's receipts beside it.
  - `host.finances.events` delivers `feeNotification.issued` and
    `memberCharge.recorded`, `corrected` and `removed`, versioned per type and
    enqueued in the same transaction as the act. An event queued when the board
    switches the plugin off is dropped, not retried.

  A plugin route reading the finances or recording deliveries requires both the
  fee and the member charge management rights. The plugin consent screen names
  the two permissions and the financial personal-data category a plugin reading
  charges declares. A manifest
  may not ask to read the finances beside publishing website blocks, as it may not
  ask for the address book there: a notice names the people it is for, and a
  website block is published to anybody. `host.finances` is feature-detected; the
  contract version stays 1. `docs/plugin-contract.md` now also says plainly that a
  plugin setting is no place for a credential.

- be2d58c: A plugin can now keep state of its own. `host.records` stores JSON values under
  a collection and a key, belonging to the plugin and to nothing else: `get`,
  `list` in key order, `put` and `delete`, each write with an optional
  compare-and-set on the record's `revision`. It needs no permission. A value is
  at most 64 KiB, and a plugin holds at most 10 000 records and 16 MiB in all.

  The records are for configuration, such as a list of screens, and never for
  people, because the access report, purging and erasure cannot see into them. A
  write carrying a personal identity number is refused, as on a page. Switching a
  plugin off keeps its records and closes them to it; removing a plugin deletes
  them, and the remove screen now says so before the board confirms. See ADR 0033.

- 1504a5a: A plugin can now say in its manifest that it handles free text, charges,
  photographs and the other personal-data categories the association's record
  of processing activities uses, not only names, apartments, residency, email and phone.

  A plugin that calls actions handles whatever those actions return. An assistant
  that passes issue reports and minutes to a model provider handles what people
  wrote, and its manifest could not say so before. The install consent screen and
  the record of processing activities written at install therefore said less than
  the plugin handled. Both now show the new categories, in Swedish and in English.

  `personalData` in a manifest and in a catalog entry takes `postalAddress`,
  `account`, `financial`, `health`, `photograph`, `freeText` and `auditTrail`, as
  well as the five it took before. `personalIdentityNumber` and `protected` are
  refused: no plugin is ever given a personal identity number or a person with
  protected personal data. The catalog index stays at version 1. An instance
  older than this one refuses the whole catalog index if one entry names a new
  category.

- a60c1fa: A plugin can now say where it connects to outside the instance, and keep an API
  key or a token as a secret setting.

  - **Recipients.** A manifest's `recipients` names each `https` origin the plugin
    connects to, what for, in Swedish and English, and which of its personal data
    categories each one receives. The install consent screen lists them, and where
    one receives personal data it fills in "yes" and the recipient in the question
    about where the plugin sends personal data. The board still says whether the
    recipient is a processor or an independent controller. A republished version
    that adds a recipient, moves one or sends one more category does not load until
    the board consents again (`recipients-widened`); one that sends a recipient
    fewer categories loads. The catalog entry carries the field in index version
    2, which an instance now reads beside version 1. The SDK exports
    `recipientsBeyondConsent`, `receivingHosts` and `RECEIVING_HOSTS_MAX_LENGTH`
    for hosts that check a declaration against its consent.
  - **Secret settings.** A settings field of type `secret` is never sent to the
    browser: the form says whether a value is stored, and a value is replaced or
    removed, never shown. It is stored encrypted, bound to the plugin and the key,
    and handed in clear only to the plugin through `host.settings.read()`.
    `host.settings.writeSecret()` lets a plugin replace its own secret, such as an
    OAuth refresh token. Every change is in the audit log by key, never by value.

- a60c1fa: A plugin can now reach the recipients it declares through the host, and every
  request that carries personal data is in the audit log.

  - **`host.recipients.fetch(id, path, init)`** sends one request to the origin
    of a declared recipient and nothing else. A path that would leave the origin,
    a host that resolves to a private address, and a redirect to another origin
    are refused.
  - **Disclosures.** A request whose body carries personal data names the
    categories and the persons it is about. Categories the recipient is not
    declared to receive, and persons with protected personal data or under a
    restriction of processing, are refused before anything is sent. Each person
    gets an audit entry before the request leaves and one with its outcome after,
    and both are on their data subject access report.
  - **The record of processing activities** lists a plugin's declared recipients
    that receive personal data. A plugin that declares none, as an entry in index
    version 1 cannot, leaves the recipients the board wrote there as they are.

- 8179942: Let a plugin install themes (ADR 0046). A plugin asking for the new
  `themes:install` permission, which the install consent screen shows, hands a
  theme package and its sha512 to `host.themes.install`, with the request its own
  route received. The core checks the digest before anything is unpacked and then
  admits the package exactly as it admits one from the catalog: the same install
  lint, the statutory register contrast included, the same staged write and the
  same lock per theme id. It installs as the person behind the request, who must
  hold `association:manage`; a request a connected app's token reached, or one on the route of a plugin that declares an AI package, is refused.

  A plugin installs over a theme it installed itself and over nothing else, and
  `host.themes.list` returns those themes with their versions. The catalog does
  not install over a plugin's theme (`theme-from-plugin`) and the composer does
  not edit it. Previewing, activating and removing stay on the theme screen,
  which now names the plugin that installed a theme and says why a catalog entry
  under the same id cannot be installed. A theme stays installed when its plugin
  is removed. The installed theme row records the plugin in a new
  `installedByPluginId` column; the audit entry is on the plugin channel and names
  the plugin and the person.

- 7971797: A plugin's view can now be offered in the application's navigation. The
  manifest's `view` takes an optional `section` - `association`, `building`,
  `board` or `settings` - and the view's entry stands in that section after the
  core's own destinations, under the view's title, in the band and in the phone's
  menu. A view that names no section is reachable by its address alone, as
  before, so existing plugins need no change.

  Naming a section asks for an entry rather than granting one. The entry is
  offered only to an account that holds what the plugin's routes require, and in
  the board's section only to the board and the administrator. `GET
/api/plugin-views` now carries, for each view, the `section` the asking account
  is offered it in, or `null`. The SDK exports `PLUGIN_VIEW_SECTIONS`,
  `PluginViewSection`, `pluginViewSchema` and `PluginView`.

- a161792: Let plugins add blocks to the association's website. A plugin declares its
  blocks in the manifest's new `blocks` field - a name, a label, an icon, a
  category and the settings the board fills in - and registers a render function
  for each with `host.blocks.register`. Declaring a block asks for the new
  `site:blocks` permission, which the install consent screen shows; a plugin may
  not ask for it beside `addressBook:read` or `addressBook:readContact`.

  The page editor offers a serving plugin's blocks beside the core's and draws
  their settings form from the declaration, and a save is held to it. A block
  the page already holds is never left out of a save: if a new version of its
  plugin asks for a setting the block does not hold, the editor names the block
  and saves nothing until the board answers it or removes the block. The
  website renders each block on the server through its plugin and prints only a
  short list of elements and attributes from the answer: no script, style, event
  handler, picture or frame reaches the page, and a link is held to the same
  schemes as a link in a paragraph. A block whose render throws, takes longer
  than two seconds, or renders something shaped like a personal identity number,
  in its text or in any attribute it keeps, is left off the page and logged, and
  the rest of the page renders. A block of a plugin that is switched off or
  removed stays on the page as stored and shows nothing. A new plugin finding, `block-refused`, reports a plugin that
  registers a block its manifest does not declare.

- b6d0aac: Give a new association a ready-made website when it finishes the setup wizard.

  Instead of one front page, setup now writes Home (the front page, with a
  welcome text), About us, the board (with the board roster), the documents
  (with the document list) and Contact (with the contact form). Each page is
  public and carries placeholder text, in the language the wizard was finished
  in, that says what the board writes there. The menu is filled in with those
  five pages and then the broker information page, in that order. The privacy
  notice is written as before.

  An association that already has a page of its own is given none of these, so
  an existing website keeps its pages, its menu and its front page; running the
  wizard again from settings adds nothing either.

- c239825: Prepare reports to Lantmäteriet's cooperative housing register
  (bostadsrättsregistret) for sending, up to the point where they would go out.
  ADR 0029 records the design.

  Each grant, transfer, termination and transfer reversal report can now be
  assembled from the register and checked against a documented content schema,
  and sent through one port to Lantmäteriet. Lantmäteriet has not published the
  technical interface yet, so every instance is bound to a transmission that
  refuses. The board keeps recording reports it made by hand, exactly as before.

  When an adapter exists, a report is refused if it could not be complete,
  including when the association's name is blank, and is checked against the
  content schema before anything is recorded. The disclosure of the
  tenant-owner's personal identity number is written to the audit log before the
  report leaves. One report per duty is sent at a time, and a send holds no
  database connection while it waits for Lantmäteriet, so it also works with a
  connection pool of one. A duty counts as discharged only when Lantmäteriet
  gives a receipt, and on Lantmäteriet's own date. A rejection or an unknown
  outcome leaves the duty owed. The data subject access report labels the two new
  audit entries.

  For API clients: `POST /api/register-reports/transmissions`
  (`{ "obligationId": "..." }`) answers `409 transmission-not-available` until
  an adapter is bound.

- 0b81f93: An administrator can now open support access from the settings, so that
  whoever hosts the instance can send somebody to help (ADR 0028). The
  administrator chooses how long it stays open, from one hour to seven days, and
  gives a reason, which is kept in the audit log for good. Any administrator can
  close it at once. It also ends at its end time, or when whoever opened it is no
  longer an administrator.

  While it is open, the host asks the management API for a sign-in link with the
  new `POST /v1/support-sessions`. The link works once, for ten minutes. The
  supporter is never added to the register and gets no account. Their session is
  read-only and lasts at most eight hours, every screen says who they are and
  when the access ends, and no screen offers them a control that would change
  anything. They see what the administrator uses to run the instance,
  and never a personal identity number, a lien, a protected person's details, the
  association's casework or an apartment binder. Every request they make is in
  the audit log on a new `SUPPORT` channel, against the administrator who opened
  the access, and the settings screen lists each supporter and when they were
  signed in.

### Patch Changes

- 63a95f4: A plugin that dispatches an action can now tell why the call was refused. The
  SDK exports the registry's refusal vocabulary, `ACTION_ERROR_REASONS`, and
  `ACTION_ERROR_MCP`, the table that says whether a connector renders each refusal
  as a protocol error or as a tool result and whether trying again could work. The
  API now reads both from the SDK, so the catalogue endpoint and a plugin read the
  same list.

  `host.actions.invoke` now rejects a refused call with an `ActionRefusal`, one
  shape for the registry's own refusals, an input the action's schema refuses and
  a refusal from the service behind the action, and `isActionRefusal` recognises
  one. It carries the reason, the status, how to render it, the retry verdict and
  the particulars, and for a token missing a scope the bearer challenge a
  connector sends back so the client can ask for that scope. Before this a plugin
  received the host's own error classes, which it cannot import. A plugin route
  that rethrows the refusal answers with the status and headers the registry would
  have, and an invalid body is now answered with a 400 there rather than as the
  plugin's failure.

- 0cde00c: A plugin can no longer act for a person on a request it kept past its response.
  The host's mark on an authenticated request now ends when the response is sent
  or its connection closes, a request whose connection closed while it was still
  being authenticated is never marked, and `host.actions.invoke` and `host.actions.list`
  refuse a request whose response has ended, as does a caller handle minted from
  it. Before this a plugin could keep a board member's request and pass it again
  from a job or while serving somebody else, and the action and its audit entry
  named the board member as the one who acted.
- 7241043: The participation share and initial share capital form on the apartment
  register can no longer undo a newer correction. The form now sends only the
  apartments the board member changed, each with the two figures as the form read
  them when it opened. If another board member has saved figures for one of them
  since, the whole save is refused and nothing in it is written. The register is
  read again, and the form says so and keeps what was typed until it is cancelled;
  opening it again then starts from the current figures. If the register cannot be
  read again, the form says to reload the page instead. Before this the form sent every apartment's figures
  on every save, so a board member who had opened it before a colleague saved put
  the colleague's figures back, and the audit log recorded that as an ordinary
  correction.

  `POST /api/apartment-register/apartment-shares` now requires `expected` on every
  row, the participation share and initial share capital the caller read, and
  answers `409` with the reason `apartment-shares-changed` when the apartment no
  longer reads them. A row that already reads what it submits is skipped as
  before, whatever it expected.

  Cancel is disabled while a save is in flight, as on the particulars form. And
  neither this form nor the particulars form now shows an apartment added to the
  register after it was opened. Before this, such an apartment's fields ignored
  every keystroke, and the save left it out.

  The register now writes a participation share in plain decimal notation, so a
  very small share such as 0.00000001 reaches the form as written and not as
  `1e-8`. Before this a form that read such a share could neither correct nor
  clear it: the share it sent back as the figure it had read was refused as not
  a number.

- 50b40a2: The audit entry for a change made through a connected app now carries the app's
  name beside its client id and host. Until now an app registered by an
  administrator without a client URI left the host empty, and a reader of the log
  could not tell which app acted without looking the client up. The name is read
  from the client's own record when the entry is written, never from the request,
  and is bounded to 100 characters. It is `null` when the client has no name or no longer exists.
- 4018271: The broker information page (`/maklarinfo`) now says when the board last
  confirmed its facts: "The board last confirmed these facts on 14 March 2026."
  It appears under the title once at least one fact is recorded.

  Saving the facts confirms them. On the facts screen the board can also confirm
  them without changing anything, with "Confirm the facts still hold". That
  is refused (409 `nothing-recorded`) while no fact is recorded, including after
  the board has cleared every fact. A connected app cannot: an `association_facts_update` call that changes no fact
  is recorded but moves no date and confirms nothing. The
  screen shows the date beside that button. Each confirmation is written to the
  audit log as `ASSOCIATION_FACTS_CONFIRMED`, with the date it replaced; a save
  is recorded as before.

  The board also sets how many months the facts count as current after a
  confirmation: from 1 to 12, and 3 unless it changes it. The setting has its own
  field and its own save on the facts screen
  (`PUT /api/site/facts/stale-after-months`, `site:manage`). Changing it confirms
  nothing and leaves both dates alone. Each change is written to the audit log as
  `ASSOCIATION_FACTS_STALE_AFTER_CHANGED`, with the old and the new number.

  On upgrade, an association that has already recorded facts gets the date of
  its last save as its confirmation date, and 3 months. No operator step is
  needed. The `association_facts_get` action now also returns `confirmedAt` and
  `staleAfterMonths`.

- 9108ab0: A broker can now ask the board to look at the facts on the broker information
  page (`/maklarinfo`) once they are older than the board's own threshold (three
  months unless the board has changed it), or when the board has recorded facts
  and never confirmed them. The threshold is counted to the instant on the Stockholm
  clock: facts confirmed at 10:00 on 19 October with a three-month threshold can
  be asked about from just after 10:00 on 19 January. A day the target month
  does not have falls on its last day. The page then shows a short form. Only an
  email address is required; a name, a firm, an apartment number and a note of
  up to 280 characters are optional, and no phone number is asked for. A
  personal identity number in any of those fields rejects the update request. Beside the button the form says who asks for the
  address, why, on what ground and for how long it is kept, and links to the
  privacy notice when the association has one.

  Nothing is released or sent to the broker automatically. The update request is stored
  in the board's queue, and every board member and administrator with an email
  address is mailed a notice once per update request. The
  notice names the apartment, if the broker gave one, and links to the queue. It
  carries none of the broker's details. The board answers by saving or confirming
  the facts under Association facts on The website, which answers every open
  update request at once. The queue is on the settings screen beside the contact inbox
  and in "To handle" on the overview, for board members and administrators. Like
  the contact inbox, it is closed to a support session: a supporter is neither
  shown the queue nor can read it, though they may read the website's screens.
  The board can dismiss an update request, which deletes it.

  A broker who asks what the association holds about them is answered from the
  same panel: a board member enters the broker's address, and every update request held
  under it is emailed to that address and to no other. Delivering it there is
  what verifies who is asking, and the board member is told only how many
  update requests it held. The update requests are never added to a person's data subject
  access report, because an address can be shared or change hands.

  The server asks the staleness question again when an update request arrives, so a form
  posted over facts the board has just confirmed is answered "already current"
  and stores nothing. The limits: the existing per-address limit on the route
  (five a minute), one open request per apartment and three per apartment in 30
  days (answered as sent), five per broker address in a day, and twenty in a day
  from everybody together. The client address is not stored. The apartment is
  never looked up in the apartment register.

  The broker's name and address are encrypted. An update request is deleted 30 days after
  the board answered it and 90 days after it arrived in any case, by a nightly
  purge at 03:07 UTC. It is a new row in the record of processing activities, and
  the audit log records an update request arriving, being answered, being dismissed and
  an extract being sent, without the broker's details or the apartment. No
  operator step is needed.

- 88a767b: The sign-in library's new endpoint for replacing a connected app's signing keys,
  `/oauth2/client/rotate-keys`, answers 404 over HTTP, like the other endpoints
  that manage a connected app. Registering a connected app stays an
  administrator's act through `POST /api/oauth-clients`.
- 38d9d26: The image ships fast-uri 3.1.9 and 4.2.3 and brace-expansion 5.0.12, past the
  published advisories against the earlier releases (GHSA-hrr3-gc8f-f4qj,
  GHSA-jvvf-x445-j334, GHSA-6j4f-fj2g-mc7p, GHSA-q2hr-2g5m-vwhr and
  GHSA-qhr7-859c-m2p7). Both are installed as dependencies of the API server's
  own dependencies: fast-uri through Fastify's schema compilers, brace-expansion
  through glob.
- e74b820: The issue queue no longer shows the apartment of a reporter with protected
  personal data. It already withheld their name, but a signed-in resident can only
  report about their own apartment, so the apartment beside the withheld name said
  where they live. The queue is read by the property manager as well as the board.
  The row now says the apartment is not shown, for every handler. The location and
  description the reporter wrote are still shown, and the reporter's own list of
  reports still shows the apartment.
- 2269843: A package left on the data volume without a record of the board's consent no
  longer verifies a licence or shows it active, on the licence screen or from
  `openbrf licence add` and `openbrf licence list`; the plugin screen still
  reports it. From those two commands, a package other than the one the board
  consented to, by name, version or install directory, no longer counts either,
  as on the screen already. `licence list` no longer prints a literal `\n` before
  each plugin's line, and a licence issued to another instance shows
  `[verified, issued to another instance]` instead of `[verified]`.
- 1358fa3: A plugin that declares a device route or a website block is now kept away from
  every permission that reads the register, including one added later: each
  permission is classified as reading it or not, and both rules follow the
  classification instead of a list of the refused.

  When a package is skipped because a device route or a website block sits beside
  a permission that reads the register, or because a device route overlaps the
  OAuth protected resource, the admin screen now words the reason in Swedish
  instead of showing the schema's English line.

- 1358fa3: A plugin the admin screen reports as refused for breaking two rules now reads as separate sentences, and the server log still names the route or resource a rule concerns.
- a84a409: Move the general meetings from the board's section of the navigation
  to the association's, and show the motions indented
  directly under it, in the band's panel and in the phone's menu sheet. A member
  who is offered the motions but not the meeting keeps them at the section's own
  level. The routes, the capabilities that gate each destination and the phone
  bar's slots are unchanged.
- dc96235: Publish the 1.0 free/paid boundary in GOVERNANCE.md and ROADMAP.md.

  The board decided the boundary on 2026-10-19. A module is paid only if it is
  (a) a service Apteo runs, (b) a contract or account Apteo holds with a third
  party, (c) design work sold as an optional theme, or (d) a module Apteo
  licenses per instance that is named in a closed list in ROADMAP.md. Adding to
  that list needs a board decision and is announced here. Statutory duties,
  security controls (sign-in, access control, the audit log, backup and restore)
  and data exports are never paid, and a core feature is never moved into a paid
  module.

  This removes "per-instance licensing" as a reason of its own and supersedes the
  "delivery into another system" test in ADR 0011. What changes on the roadmap:

  - The licensed modules are the MCP Connector, autogiro and bankgiro files, the
    approval step before a charge leaves, and parking space sharing.
  - Every other paid module states its reason. Recurring address book import,
    digital signage, advanced finances and the advanced booking, broker and
    property manager packages are split, so the free part of each is named.
  - Maintenance planning is free. Fee notice sending, the display mode for
    screens and re-running an address book import with a diff to review are on the
    roadmap as free.
  - Reporting to Lantmäteriet, the transmission included, is never paid.

  No code changes, and nothing that is free today becomes paid.

- 82b3ed5: Signing in now lands on an overview at `/app` ("Overview"). Everybody who lives
  in the house sees what they have sent in and are still waiting on - open
  issues, and motions, subletting applications and key orders the board has not
  answered - with each one's status and a link, their upcoming bookings, the next
  events and the three newest news items. Whoever works a queue also gets "To
  handle": one row per queue their account holds, with how many items are
  waiting and a link to it - new issues, unanswered threads in the board mailbox,
  motions not yet received, subletting applications and key orders to answer,
  account requests and reported posts. A panel whose read fails says so
  on its own; the rest of the page still shows.

  The address book has moved to `/app/address-book`, and its entry in the
  navigation is now in the board's section and offered on the board's view of it. A
  resident still reaches the resident directory at that address, but the menu no
  longer carries a link to it for them. The phone bar's first column is the
  overview, for the board and for residents; residents' bar no longer holds
  "News", whose newest items are on the overview.

- 2fe1bcb: Declare each website block type once. A block type's stored shape, strict
  schema, reading, the text the publication guardrails scan and how the page
  editor offers it are now one definition in `@openbrf/shared`, read by the API
  and the editor alike, and the website's renderer is keyed by the same types.
  Every existing block reads, saves and renders as before, and stored pages are
  unchanged.

  A block whose type is namespaced as a plugin's, `<plugin id>/<name>`, and that
  no installed plugin defines now shows nothing on the website and is kept when
  the page is saved, instead of being dropped. The page editor shows it as a
  plugin's block that can be moved or removed. Its text is scanned for personal
  identity numbers before the page is published. Such a block is limited to
  10 000 characters of JSON and 32 levels of nesting; one over either is refused
  when the page is saved. The page actions show it but do not accept it back.

- f8423fd: `openbrf plugin add` now lists a plugin's device routes before the places it
  connects to, the order the consent screen shows them in.
- bb6c87c: A plugin's writes to `host.records` now wait their turn in the instance's own
  process, so a burst of them holds one database connection at a time instead of
  one each, and can no longer take the connections every other request needs.

  Installing a plugin whose catalog entry names a different package than the one
  installed under the same id is now refused with the reason
  `plugin-package-changed`. The other package would have taken over the installed
  plugin's settings, records and device tokens. The plugin screen says to remove the installed
  plugin first, which deletes them.

- 6d05800: A plugin's controller can now raise a route above its capability floor with
  `RequireCapability`, exported from `@openbrf/plugin-sdk` with the metadata key
  it writes (`REQUIRED_CAPABILITIES_KEY`) and the capability names a route may
  require (`PLUGIN_ROUTE_CAPABILITIES`, `PluginRouteCapability`). Before this a
  plugin had to set the key itself with `SetMetadata`. The API's own decorator is
  the same one, so the two cannot disagree on the key.
- 78396aa: Answer a plugin's theme install with 403 and `forbidden-capability` when the
  request it passes is not one the platform authenticated, instead of a 500 with
  no reason.
  A request the platform authenticated but has since answered, because the
  plugin kept it past its response, keeps its own error and is not reported as a
  refusal.
- 87f92ee: A member list can now be imported again whenever a newer file arrives. A file
  is recognised by its column titles: the mapping the board last started an
  import from such a file with is offered in place of the guess, and a file that
  holds exactly the rows imported last is answered with "nothing new in this
  file" instead of a preview, with a button to review it anyway. A file the
  register did not take whole, because rows had problems or the import stopped,
  is always reviewed. What is kept for such a file names nobody: a keyed digest
  of its column titles, the mapping, and a keyed digest of the rows last
  imported. It is deleted once no import has used it for two years.

  The preview of a file imported again tells the rows the register already agrees
  with ("No change") apart from the updates that change it, and says what each of
  those adds: an email address, a phone number, a postal address or a residency.
  Below the rows it lists the residencies the register holds today that no row of
  the file reaches. That list is for reading only: the import never ends a
  residency, because a file that leaves somebody out does not say they have
  moved.

  A preview planned before this version, in a session uploaded within the last
  day, is reported as outdated and taken again.

- 24cf686: The record of processing activities now names Lantmäteriet (bostadsrättsregistret)
  as a recipient of the apartment register and of the reporting ledger, with the
  provisions that oblige the association to hand data over (Lag (2026:485) 3 § and
  Lag (2026:484) 3 kap.), in Swedish and English. GDPR art. 30(1)(d) asks for every
  category of recipient, and the initial supply already reaches the authority.
- e5499c6: Keep the schema owner's and the runtime role's passwords out of the database's
  log. The deploy steps used to send each password inside the `ALTER ROLE`
  statement that sets it. PostgreSQL logs a failed statement in full, and logs
  every statement on a server set to `log_statement = ddl`, so the password could
  end up in the `db` container's log. The steps now work out the password's
  SCRAM-SHA-256 verifier themselves, as psql's `\password` does, and send that
  instead. PostgreSQL stores a verifier as it is given, so signing in does not
  change. That includes a password you supply with characters SASLprep changes,
  such as a ligature or a non-breaking space: the steps prepare it with SASLprep
  exactly as PostgreSQL does before they hash it.

  docs/deployment.md, "On a platform that shares every variable", now has an
  instance that set its passwords as variables give its superuser a new password.
  Until now it kept the old one, which the platform had handed to every service.
  The docs no longer have it keep `POSTGRES_PASSWORD` for one deploy either: on
  such a platform both the database and the application refuse that variable.

- be022d4: A post the board scheduled as Styrelsen is published only if the board member
  who scheduled it still speaks for the board when its time comes. If their seat
  has ended meanwhile, the post stays a draft, is not mailed, and is hidden from
  residents and from the feed. The board that remains still sees it among the
  scheduled posts beside the feed and can withdraw it there, including a post to
  Styrelsen or Administratörer, which is not on the news screen. A draft to Alla
  is also on the news screen, where an administrator sees it.
- 88424ae: Split the settings screen into sections, each at an address of its own:
  `/app/settings/account`, `association`, `appearance`, `communication`,
  `account-requests`, `issues-bookings`, `meetings` and `data-protection`. A list
  of the sections sits beside the content from 1024px and above it on a narrower screen.
  The back button moves between the sections you opened, and a section can be
  linked to. `/app/settings` opens the first section you have, which is your own
  account, and so does a section that does not exist or that you have nothing in.

  Who sees which panel has not changed. A resident still sees only their own
  profile and security, now as the one section "My account". The email that tells
  the board about a message from the website's contact form now links to the
  section with the inbox rather than to the top of the settings.

- 5fea6a5: Uploaded images are stored without their EXIF, XMP and IPTC metadata. A photo
  used to be kept and served exactly as it arrived, so the position and capture
  time a phone writes into it reached everyone allowed to open the file, such as a
  property manager looking at an issue photo whose apartment is masked. JPEG, PNG,
  WebP and GIF now lose their metadata, comments and anything appended after the
  image, and the picture itself is copied unchanged, without being re-encoded. The
  orientation is kept, so a portrait photo still shows upright. An image whose
  structure cannot be followed to its end, or that is made of more than 65,536
  segments, chunks or blocks, is refused instead of stored. The colour profile is
  kept as it came. Images already stored are not changed.
- 3e0cec8: When a plugin's new version turns a settings field from `text` into `secret`,
  the value the board saved while it was plain is now removed from the stored
  settings the next time the plugin starts serving. Until now it stayed there,
  unencrypted, until the settings form was saved again, although neither the
  plugin nor the admin screen ever read it. The field is unset until the board
  enters it again, as before. A plugin that is switched off or not loaded keeps
  its stored settings as they were.

  A recipient's origin in a manifest no longer accepts an IP address, `localhost`
  or a host name with a trailing dot: the consent screen names a party the board
  can recognise, and the same host has one spelling.

- df37052: Edit the association's website pages as they look. The page editor now has an
  address of its own (`/app/admin/site/pages/<id>`) and draws the page with the
  website's own markup and stylesheet, in the active theme, so what the board
  writes is laid out the way a visitor will read it.

  - **Write where the words stand.** The title, paragraphs, headings, captions,
    a banner's heading and text, a button's label and the questions and answers
    are edited in place on the page.
  - **Add with +.** A + at the end of the page, in each empty column and in the
    tools of every block opens a list of the blocks that may stand there, by
    category, with a search.
  - **Settings beside the page.** A selected block shows its settings in a side
    panel - its picture and description, where a button leads, a heading's rank,
    the number of columns - next to the page's own: who can read it, Use as
    front page, and its address under Advanced.
  - **Arrange by dragging or from the keyboard.** A block is dragged by its
    handle, into and out of columns. The same handle picks it up with Enter or
    Space, the arrow keys move it through every place it could be dropped, and
    each step is announced to a screen reader; Move up and Move down stay.
  - **Duplicate and remove with Undo.** The last changes to the arrangement can
    be taken back without touching the words written since.
  - **Leaving with changes not saved is asked about**, inside the application
    and when the browser tab is closed.

  The separate preview is gone: the page is its own preview. The website's
  layout stylesheet moved from the API to `@openbrf/shared` so the editor and the
  website read one copy, and a button is styled by its class rather than as a
  link, which changes nothing a visitor sees. Stored pages are unchanged.

- Updated dependencies [63a95f4]
- Updated dependencies [e511e0e]
- Updated dependencies [e511e0e]
- Updated dependencies [0cde00c]
- Updated dependencies [3b2a3e3]
- Updated dependencies [7241043]
- Updated dependencies [55d2030]
- Updated dependencies [309f885]
- Updated dependencies [4018271]
- Updated dependencies [9108ab0]
- Updated dependencies [c198a01]
- Updated dependencies [10d3aa4]
- Updated dependencies [cbb9891]
- Updated dependencies [a9f6b95]
- Updated dependencies [e5ac99f]
- Updated dependencies [6e3a547]
- Updated dependencies [c46aeff]
- Updated dependencies [69cc696]
- Updated dependencies [3a6bf92]
- Updated dependencies [e74b820]
- Updated dependencies [101cee1]
- Updated dependencies [f51309d]
- Updated dependencies [1358fa3]
- Updated dependencies [a84a409]
- Updated dependencies [16a59c1]
- Updated dependencies [dc96235]
- Updated dependencies [82b3ed5]
- Updated dependencies [2fe1bcb]
- Updated dependencies [039e65c]
- Updated dependencies [e4cf311]
- Updated dependencies [4ced8ff]
- Updated dependencies [4f60b06]
- Updated dependencies [a050e5b]
- Updated dependencies [4135ce7]
- Updated dependencies [be2d58c]
- Updated dependencies [1504a5a]
- Updated dependencies [a60c1fa]
- Updated dependencies [a60c1fa]
- Updated dependencies [bb6c87c]
- Updated dependencies [6d05800]
- Updated dependencies [8179942]
- Updated dependencies [7971797]
- Updated dependencies [a161792]
- Updated dependencies [87f92ee]
- Updated dependencies [b6d0aac]
- Updated dependencies [24cf686]
- Updated dependencies [c239825]
- Updated dependencies [e5499c6]
- Updated dependencies [5d3a690]
- Updated dependencies [88424ae]
- Updated dependencies [3e0cec8]
- Updated dependencies [0b81f93]
- Updated dependencies [65c3019]
- Updated dependencies [df37052]
  - @openbrf/plugin-sdk@1.1.0
  - @openbrf/i18n@0.3.0
  - @openbrf/shared@0.3.0

## 0.2.0

### Minor Changes

- 21a3b1c: Run the production stack on a platform that gives every service every
  variable, such as Coolify, by generating the database passwords instead of
  asking for them.

  `docker-compose.prod.yml` asks for no database password any more. A new
  `superuser-password` service puts the database superuser's password in place
  before the database starts, generating one on a first boot and on no other;
  `schema-owner` generates the schema owner's, and `migrate` the runtime role's.
  Each is kept on a volume that only the services using it mount, so the
  application's container never holds the superuser's or the owner's password,
  whatever a platform hands it. On Coolify 0.1.0 crash-looped on exactly that:
  every variable reached the application, which refused to start holding them.

  An instance that sets `POSTGRES_PASSWORD`, `OWNER_DB_PASSWORD` and
  `RUNTIME_DB_PASSWORD` keeps working unchanged: a variable that is set wins, and
  the first `up` writes `POSTGRES_PASSWORD` onto the superuser's volume, after
  which all three can be emptied. docs/deployment.md, "The database passwords",
  covers this, a lost superuser password, and "On a platform that shares every
  variable" what to set there.

  **Act on this when upgrading:** the application no longer publishes a port on
  the host. A reverse proxy on the stack's network reaches it as `app:3000`; one
  on the host itself adds the new release asset `docker-compose.host-port.yml` to
  every `up`, which publishes it at `APP_BIND_ADDRESS` and `APP_PORT` as before.

  A `BETTER_AUTH_SECRET` with whitespace in it is refused at start in
  production. That includes the compose file's own message for a missing value,
  which Coolify fills the variable in with and which the earlier checks let
  through.

### Patch Changes

- Updated dependencies [21a3b1c]
  - @openbrf/i18n@0.2.0
  - @openbrf/shared@0.2.0

## 0.1.0

### Minor Changes

- 87bcb63: Put everything the association keeps against a person on their data subject
  access report.

  The report states the sessions a person's account is signed in with - when each
  began, when it was last renewed, when it ends, and the IP address and browser it
  came from - the passkeys on the account, the invitations to an account they were
  sent, and every news mailing, SMS mailing and notice of a general meeting
  addressed to them, with whether it went out and, where it did not, why. None of
  it carries a token, a password hash or anything else that opens the account.

  The printed report shows the charges, fee rates and fee notices the report
  already held.

  A test fails for any column in the database that names a person unless the
  report reads it or the reason it does not is written down, and four such
  reasons are open questions named in ADR 0019.

  A signed-in session is deleted the night after it ends, unless a legal hold or a
  restriction stands for the person, and the purge deletes every invitation to an
  account with the account, accepted or not. The record of processing activities
  says so, names former residents and everybody an invitation or a general meeting
  can reach on the rows these belong to, and no longer says that the board deletes
  decided sign-up requests, which nothing does.

- b4954e7: The board can hand whoever keeps the association's books one file with the
  period's fees and charges in it.

  Until now the two halves of the association's money left in two documents: the
  debiting list for the charges and the notice document for the fees. The
  accounting basis is both of them for a period the board states, with a column
  contract published in `docs/accounting-basis-contract.md` so a mapping into the
  accounting program is written once and then left alone. It is offered from the
  fee screen and from the charge screen alike, because a board member looking for
  it should not have to know which half it was filed under.

  A charge belongs to the day it is dated. A notification run belongs to the
  period its own period opens in and is carried whole: what is billed to an
  apartment for a quarter has no exact part, and this product refuses to apportion an amount
  rather than rounding one. Over consecutive periods that means every run lands in
  exactly one file - never counted twice, never falling between two.

  There is no SIE file and none is planned. The contract document records what one
  would have cost, so that whoever revisits the question has the argument rather
  than having to rediscover it: the transactions file type would have fitted a
  platform with no ledger, and what it asks for is a legacy code page transcode, a
  quoting rule of its own and a writer nobody has written for this language -
  against a bookkeeper mapping eleven columns once.

  The fee half of the file names nobody, and that is deliberate. The notice
  document withholds a protected household's names and prints their apartment,
  while the debiting list prints a protected person's name and withholds their
  apartment. A file carrying both would say, of one apartment, that its holders
  are withheld and, of one person, that their apartment is - and a reader holding
  the two rows could put the name back against the door. So the file withholds in
  one direction only, and a charge on a protected member names them and withholds
  their apartment exactly as the debiting list already does.

  The file carries no account numbers, no vouchers and no balances, and says
  nothing about payment: Open BRF holds the basis and the accounting system holds
  the debt. Producing it is an audited disclosure - a copy of named apartments'
  and named people's money leaving the association - so it happens when somebody
  asks for it rather than when a page is opened, and the entry it writes carries
  the period and nothing that was in the file. Whoever asks has to hold both
  halves themselves: one seat that may manage the fees and may manage the charges,
  and not two seats between them.

  Every file this product hands out is also safer to open. A cell beginning with
  an equals sign, a plus, a minus, an at sign, a tab or a carriage return is what
  a spreadsheet runs as a formula rather than showing as text, and the free-text
  columns in these files are what a board typed - a charge's reason, a creditor's
  name. Such a cell is now prefixed with an apostrophe, which every spreadsheet
  reads as "what follows is text". Amounts are left exactly as they are, minus
  sign and all, because a figure turned into text is a worse fault than the one
  the prefix is for. This reaches the debiting list, the fee notices, the member
  import template and the file for the cooperative housing register as well as
  the new one.

- a7be0c9: The platform can now be asked to do things through one place, and it checks who
  is asking every single time.

  An action is one thing the platform can do: a name, the shape of what it takes,
  the single capability it needs, whether it reads, writes or deletes, and which
  personal data it can touch. Core features register their own, and a plugin
  registers the ones it declared in its manifest and the board agreed to. Nothing
  about registering an action grants anybody anything - before every call the
  registry works out afresh what the calling person may do, from the register as
  it stands, so a board term ending narrows what an app may do the same night it
  narrows the person.

  Declaring an action does not offer it beyond the instance. An administrator
  switches each one on, one at a time, on the plugin's own screen; until then it
  is reachable only in process. Switching one off takes effect on the next call,
  and the switches are cleared whenever the board consents to a new version of a
  plugin, because an action that keeps its name while changing the capability it
  needs is a different action.

  The first slice is the association's website: writing, publishing and arranging
  news items, pages and the menu - twenty-four actions in all, each with a
  Swedish sentence saying what it does and, as plainly, what it does not do.

  None of them can mail the members. An email reaches everyone in the register
  whose address the association holds and cannot be recalled, so that decision
  stays with a person: an action can record that a news item ought to go out, the
  board sees the request on the item, and a board member sends it in the ordinary
  way. A published news item now also says, in its own text, that what it returns
  was written by people and is information rather than instructions.

  Every change these actions make is recorded in the audit log with the way it
  came in and, where an app was acting, which app. Rewriting the body of a page
  or a news item is recorded too, which it was not before: publication used to be
  the only recorded act, and that was enough only while a board member in a
  browser was the only writer.

- 66e2d3c: Add the address book: the board the register lives on, and the API behind it.

  The board panel per the design system, with house tabs per address, on-board
  filter tabs, floor-grouped rows following Lantmateriet numbering, the mono data
  grid, role and state signs, the always-visible colour-as-law legend and a
  register stamp. A person view and an apartment view beside it, search that
  matches names and apartment numbers incrementally while an encrypted email or
  phone number matches only in full and only for the board, and pagination.

  Masking is enforced server-side per the visibility matrix. The board sees
  contact data with protected persons masked and a per-field reveal that writes its
  audit entry in the same transaction as the read; residents see names, apartments,
  roles and dates, with the contact column absent rather than empty, and protected
  persons excluded from their view entirely apart from their own entry. A personal
  identity number appears in no list, masked or not.

- 2f8ddd9: The papers about an apartment can be kept with the apartment, for whoever lives
  there.

  A lägenhetspärm is the binder about one home: its drawings, the board's
  alteration permissions, records of what was done and when, and manuals for
  what is installed. On paper it passes from seller to buyer with the keys, and
  that is what this is. Nothing in the service tier worked that way before: every
  resident-facing list filters by the person who created the row, and the one
  record that already follows the apartment is the statutory register extract.

  An entry is one PDF with one of six kinds, a title, a date where the kind has
  one, and an audience: the tenant-owners, or the whole household. The two are
  different people and the register cannot tell them apart any more finely - a
  partner, an adult child and a second-hand tenant are one residency role - so a
  permission's conditions go to the tenant-owners and the dishwasher's manual to
  everybody living there.

  Reading follows the residency and is decided on every request. When the
  apartment changes hands nothing happens at all: no job, no hook, no copy. The
  next household reads the binder from the day its residency begins and the last
  one stops on the day its residency ends. A buyer the board recorded before
  tillträde reads nothing, because a residency is held from its move-in day.

  The board's permission under BRL 7 kap. 7 § is a kind only the board can file,
  and it carries the day the board decided - both held by the database as well as
  by the service, because what the binder is worth to the next holder is that
  tillstånd means the board said so. It is stated and never enforced: the section
  gives the permission to the tenant-owner and says nothing about whether a
  condition binds the next one, so the platform says nothing either.

  The board reads every binder through a capability a board seat confers and
  nothing else does. This is the first capability the administrator's grant
  withholds, and it is withheld in the types rather than by a branch: an
  administrator who holds no seat - including whoever operates a hosted instance -
  is answered 404 for a household's papers, at the list and at the file alike. An
  association whose administrator needs to reach a binder gives them a seat. Every
  board read of a binder is written to the audit log - the listing as well as the
  file, because the titles are what say what was done in somebody's home, and a
  board that could browse them silently would be the thing the capability was
  narrowed to prevent. The entry says which apartment and how many entries, never
  a title. A household reading its own binder is not logged, because its residency
  is the whole of that rule.

  A binder names nobody. An entry says whether the board or a tenant-owner filed
  it, and the reader is told which are their own, and that is all - one rule for
  every household rather than a rule with an exception for people who live
  together, which is also what protects a tenant-owner with protected personal
  data. The file name a household uploads stays off the audit log, both when the
  file is filed and when it is taken out, because that log is append-only and
  exempt from every purge - and taking an entry out is how the board carries out
  a request to erase one, so a name left there would outlive the erasure itself.

  A title or a file name carrying a personal identity number is refused, naming
  the field and never the number. The file name is checked as it would be stored
  rather than as it arrived: the stored name has path punctuation and invisible
  characters taken out of it, and taking a character out can join what it
  separated, so a name that looked harmless on the way in could be written down
  as somebody's personnummer. The file itself cannot be read for one, and the
  form will say so.

  The files are encrypted at rest, each under a key of its own, like every other
  stored file, and the association's record of processing activities gains a row
  that says so.

  There is no screen yet. This is the schema, the two per-apartment file
  visibilities, the API, the purge, the access report and the paperwork; the screen
  follows.

- df165a8: The audit log now records which way each change reached the association's
  records, and the data subject access report prints it.

  Until now the log answered who did what, and could not say how they reached the
  records. That was enough while a person in a browser was the only way in. The
  column names one of five routes on every entry written from now on: the web
  interface, a connected app acting as the person who connected it, the AI
  package, the association's own nightly jobs, or a plugin. Where a connected app
  acted, the entry also names which app.

  Entries written before the column existed carry no channel, and cannot be given
  one: the log is append-only, which is what makes it evidence. The data subject
  access report says so in words rather than leaving the cell blank, because a
  blank cell on a statutory document reads as though nothing happened.

  The report also names sixteen acts it could not name before. Twelve of them the
  log had been recording all along and the document printed as an empty cell -
  charges entered and corrected, the debiting list exported, the board mailbox
  worked, a transfer reversed, how the association holds its land. Those cells now
  carry a sentence in the association's own words, and an act added to the log in
  future cannot reach the report unnamed.

  Every edit of the website's menu is now recorded, the board's own edits
  included. The menu decides what is offered rather than what may be read, which
  is why it went unrecorded; it is also the one place on a public page where an
  address leaving the instance can be planted, so the entry names where an
  external entry points.

- ca89fbc: Refuse to start in production with a `BETTER_AUTH_SECRET` shorter than 32
  characters or equal to the development placeholder, and say how to generate
  one. `.env.production.example` now says the same.

  **Upgrade note:** a production deploy whose secret is shorter than 32
  characters, or is the placeholder, stops booting after this release until the
  secret is replaced. Generate one (`openssl rand -base64 48`) and set it before
  updating. A deploy whose secret already meets the rule needs nothing, and should
  keep the secret it has: it does more than sign.

  Replacing the secret:

  - signs everybody out, because every session is signed with it. A sign-in
    link already sent is not affected: its token is random and stored hashed
    without the secret, so it still works until it expires, 15 minutes after it
    was sent;
  - makes every enrolled second factor unusable, because the authenticator
    secrets and the recovery codes are encrypted with it. A member who enrolled
    one can no longer finish signing in, and there is no reset in the interface
    yet. Remove the second factors in one transaction, so a failure cannot leave
    an account that asks for a factor it no longer has:

    ```sql
    BEGIN;
    DELETE FROM auth_two_factor;
    UPDATE auth_user SET "twoFactorEnabled" = false;
    COMMIT;
    ```

    and ask those members to enrol again;

  - makes the secret of every connected app registered with one unreadable, so
    those apps can no longer sign in. Register each of them again, and give the
    app the new client id and secret.

- f5f23a6: Add the board's own chat: a room for the people holding a seat, and what becomes
  of what they write in it.

  A chat is a running conversation between a fixed set of people, read and written
  nowhere else. It is not a thread, which is one correspondence the board mailbox
  holds with somebody outside the association about one matter, and not a comment,
  which sits under one news item and is as visible as that item: a chat has members
  and no subject. There is one room today, the board's own, and its members are not
  written down but derived - everybody holding a board seat that has not ended. A
  person joins it the day their term is recorded and leaves it the day the term
  ends, without anybody administering a list. A full discussion forum is
  deliberately never built.

  The capability opens the endpoints and membership decides what is in them, and
  the two stay separate questions. `chat:participate` is the board's, so a resident
  and a member are both refused the routes, and the external property manager is
  refused on the same footing as a news comment - they handle the association's
  issues and were not elected to anything. The administrator holds every capability
  through the ADMIN grant and holds no seat, so they reach every route and find no
  room; the screen says why in Swedish rather than rendering an empty conversation,
  because a room whose membership comes from an election is not something a grant
  can open. A room that does not exist and a room somebody is not in are one
  refusal, so the identifier space cannot be walked to learn what rooms the
  association has.

  Nothing is ever erased except by the retention clock. There is no edit, no
  delete and no withdraw, by the author or by anybody else, and no strike-through
  either - which is where the board chat parts company with a comment thread. A
  thread under a notice is part of what the association publishes and the board
  answers for it; the board chat publishes nothing and the board is the whole room,
  so a board able to strike a colleague's line would be deciding what the record of
  its own deliberation says.

  Nothing is rendered on the association's website, which reads no session at all,
  and the module imports nothing from it and exports nothing to it.

  Delivery is a poll and not a stream, recorded in ADR 0010 along with what was
  rejected and why. A screen asks for what has been written since a cursor it was
  given, every four seconds, and only while the tab is being looked at - a
  forgotten tab on a phone would otherwise ask for days, and one request is made
  immediately when the tab comes back, because that is when somebody wants what
  arrived while they were away. Nothing is appended by the browser: a written
  message clears the box and a read brings the row, which is what makes the poll
  the one delivery path rather than a second opinion about one. Both directions of
  the cursor survive a message purged out from under a reader, and the poll answers
  a bounded page and says whether more is waiting, so a screen closed for a week
  catches up a page at a time instead of asking for a week of messages at once.

  Nothing notifies by mail, and there is a read marker instead - one row per person
  per room, so the screen can say what is unread. It only ever moves forward, so
  two tabs cannot un-read each other, and it is marked at the newest message
  actually on screen rather than at the moment of the call.

  A personal identity number refuses the message, naming the position in the text
  and never the number. The board may read the apartment register, and that is
  exactly why the rule holds here: a number copied out of it into a service-tier
  room is a second copy the register cannot account for, held on a different clock,
  in a room the register's own rules do not reach. A message is capped in length
  and each person has a budget of messages per ten minutes, counted from what they
  actually wrote so that it survives a restart and is the same budget in every
  process.

  A message write is not audited, and the departure from the comment precedent is
  deliberate. A comment's audit entry exists because a member's own words about a
  notice are their data and their access report has to say when they wrote them; a
  chat message is on that report in full, carrying its author and its instant, so
  the entry would restate the row. A board of eight at thirty messages a day is
  about eleven thousand rows a year in a table the database refuses to update or
  delete and every purge is forbidden to touch. What is audited is the acts that
  change who can read a room, and in the board chat there are none: nobody is put
  into the room or taken out of it, an election is.

  Every message is on the data subject access report and in the portability export,
  in full, grouped by the room it was written in and carrying the earliest date the
  purge can reach it. The read marker travels with the room rather than as a
  section of its own. Only the reader's own messages are there - a room's other
  members wrote about themselves and about the association's business, and a report
  carrying the whole room would hand one board member everything the other seven
  said. An author with protected personal data is named to nobody, every reader of
  the room included, although each of them holds the capability to reveal protected
  data with their seat: that capability is what lets somebody perform an act of
  revealing and be recorded doing it, and a name appearing in a payload nothing
  audits is not that act.

  A nightly job erases messages a year after they were written, on each message's
  own clock rather than the room's. A chat has no end, so anchoring on the last
  message would mean a room somebody writes in every week purges nothing, ever. A
  legal hold standing against the author stops it, inside the eligibility query as
  well as inside the deleting transaction, so held people can neither be erased nor
  fill a run with work that cannot be done. The chat has its own record of
  processing activities entry under GDPR art. 30 rather than joining one.

  The room model carries a kind from the first migration, with a second value in
  the enum that the service refuses. A group's chat is built next, and the
  discriminator being there already is what keeps that from being a migration over
  live rows.

- edcb7ed: Add the shared board mailbox: mail to the board's address as a thread the
  whole board works.

  Mail sent to the address the board publishes arrives as a thread every board
  member can see. One board member takes it on, which writes their name onto the row the
  others are reading, and answers it from the application; the answer goes out
  through the instance's own mail server with the board's address in Reply-To, so
  the correspondent's reply lands back on the same thread. The thread stays as the
  record of what the association was asked and what it said. Taking a thread is
  deliberately not exclusive - a letter locked to whoever opened it first, who then
  goes on holiday, is the failure the module exists to end.

  Mail comes in by collecting a mailbox the board already has, over POP3, on the
  job schedule and on demand from the screen. That follows from the deployment
  promise rather than from a preference: the platform installs with one Compose
  command, and receiving mail directly would need port 25 open to the internet, an
  MX record, a public hostname with a certificate and a spam defence. The POP3
  client and the MIME reader are written against the specifications over the
  runtime's own sockets and `TextDecoder`, so the feature adds no dependency.
  Nothing is deleted from the mailbox; collecting the same letter twice is
  prevented by its unique identifier under a unique constraint.

  Everything that arrives is untrusted input from outside the association. The
  body is stored as text and an HTML part is converted as it is read, so no markup
  is ever kept; attachments go through the ordinary upload path and are identified
  from their own bytes rather than from the declared type; and the sender is the
  address the envelope asserted, never resolved to a person in the register. A
  thread is service tier: it is erased two years after the last message on it, a
  legal hold against the person whose address it is with suspends the erasure, and
  it appears in the data subject access report of the person the address was
  established to belong to when the letter arrived.

  The inbox and a thread are both read a page at a time, the inbox from the
  end that is still owed something and a thread from its newest message, with the
  page before each one a press away. How much there is to read is decided by how
  much mail is sent to an address the association publishes, which is not a number
  this instance chooses.

  The board's screen is behind `boardMailbox:handle`, which the external property
  manager deliberately does not hold. Where the mail is collected from, and with
  which credentials, is an administrator's setting beside SMTP.

- fb94375: Record a board on a register that has none through an explicit, audited board
  recovery, and nowhere else.

  A person who holds no board seat no longer records or corrects board positions
  through the ordinary election and end-of-term routes, whatever the register
  holds. Those writes answer `board-seat-required`, as they did once a board had
  been elected.

  A register on which no seat is held today and none is recorded ahead is vacant,
  and is recorded with `POST /api/board-positions/recovery`: the seats the general
  meeting elected, and a stated reason of at most 500 characters. The recovery is
  refused with `board-not-vacant` (409) while any seat is held or recorded ahead,
  whether or not its holder can sign in, with `recovery-dated-ahead` (409) when a
  seat is dated after today, with `board-seat-required` (403) when it names the
  caller's own seat, and with `invalid-body` (400) without a reason. All
  the seats are recorded or none. Each seat gets its own audit entry under the new
  action `BOARD_RECOVERY_RECORDED`, which carries the reason. The data subject
  access report labels the action. `GET /api/board-positions/recovery` says whether
  the register is vacant.

  On a vacant register the person panel's election form becomes a board recovery.
  It asks for the reason, says that the reason is kept in the audit log for good,
  and records that one person. Once that person signs in, they record the rest of
  the board.

  Upgrading: the migration adds the `BOARD_RECOVERY_RECORDED` audit action. An
  instance whose board was recorded by an administrator before this release keeps
  it. From this release on, that board corrects its own seats.

- ca89fbc: Keep the board's seats in the board's hands, and keep their dates plausible.

  A person who holds no board seat may record and correct board positions only
  while no seat that has not ended belongs to somebody who can sign in, to enter
  the first board in full, and never their own seat. Seats recorded from a day
  still to come count, so the days between one board and the next are not a way
  in. Once a board has been elected, only a board member records elections and
  ends terms. A refused write answers `board-seat-required`, and the person panel says
  why.

  An election dated more than a year ahead is refused with
  `elected-too-far-ahead`. An election that has not begun can be given an end
  date before its election date, which withdraws it: the seat then covers no day
  and the position can be recorded again, also while that end date is still
  ahead. A withdrawn election is then settled like a term that has run out: its
  end date is refused a second time (`term-already-ended`), so it cannot be moved
  over the election that replaced it. A new election that overlaps an earlier
  term in the same position is refused with `term-overlaps`.

- 1069165: Cover resource booking end to end against the production image, and give
  whoever runs the calendar an endpoint that serves the catalogue of what the
  house offers.

  The suite drives a browser through the five properties of the module that only
  exist once the interface, the API, the association's clock and a real database
  are in the same room. A resident takes a laundry hour and the calendar then
  states the hour as theirs rather than as somebody's. A second household loses
  the race for the same hour: the first booking lands while the second reader's
  page is open, the database refuses the second claim through its partial unique
  index, and the screen turns that code into the one sentence that says both what
  happened and that the calendar has moved on. The allowance is the apartment's,
  so a second person living there is refused although they hold nothing of their
  own. The board cancels on somebody else's behalf from the half of the screen its
  capability opens, that half names the household holding the hour, and the hour
  is back on the calendar afterwards. The external property manager has no
  bookings entry in the navigation and no panel on the screen behind it.

  Every date the suite books on is computed from the day the run happens, because
  the API refuses a slot that has begun and a date written into a file stops being
  in the future.

  The catalogue of what the house offers is now also served from the board's own
  base path. It was reachable only behind `bookings:book` and behind
  `bookings:configure`, so a principal holding `bookings:manage` alone - which no
  seat grants today and one may - had no endpoint for a list its own screen needs
  in order to name a resource. A second route rather than one route serving both
  audiences, because the capabilities a route declares are read together: naming
  both halves of the house on one of them would demand both and refuse each
  audience the other's capability. What the new route answers is the same summary
  the resident calendar is given, with no booking count and no withdrawn resource
  on it, and there is no write route beside it - so the configuration surface stays
  where it was.

- 4464ee7: Add the slot engine and the booking API: residents can see what a bookable
  resource offers, take a slot, cancel their own, and the board can see who holds
  what and cancel on somebody's behalf.

  Slots are generated from the board's configuration and never stored. A stored
  calendar would be a second copy of the opening hours that has to be regenerated
  when the board changes them, and would be wrong until it was. A resource booked
  in time slots offers its day cut into equal pieces between opening and closing;
  one booked by the whole day offers one slot a day; one booked by the night
  offers one night a day, and a stay runs from a check-in to a check-out.

  All of it on the association's own clock. A laundry room opens at seven every
  morning, including the two mornings a year that are 23 and 25 hours long, so a
  time of day is converted to an instant through the calendar rather than by
  adding hours - and the instant seven o'clock names moves by an hour twice a
  year. The two Sundays are handled by the boundaries themselves: a slot ends
  where the next one begins, so the hour the clocks skip in March simply is not
  offered and the hour the wall clock repeats in October belongs to the slot that
  was already running. A resource open around the clock therefore offers 23 slots
  on one of those Sundays and 24 on the other, and the room still opens at seven
  on both.

  The double booking is refused by the database. A slot is claimed by an insert
  that the partial unique index arbitrates, in the same transaction as the audit
  entry that records it, so two residents claiming the same hour in the same
  instant end with one booking and one refusal - and the refusal is the same
  reason a read taken a moment earlier would have given. The loser's audit entry
  rolls back with the insert that affected nothing, because they were never
  separate acts.

  The quota is derived at write time and stored nowhere. Both limits the board
  sets are counted from the bookings the apartment holds, and the apartment comes
  from the booker's own residency rows, which makes three things true with no
  bookkeeping at all: joint holders of one apartment share one allowance because
  they book against one apartment; a cancelled booking gives its share back the
  moment it is cancelled; and a residency with a move-out date on the Thursday
  stops that person booking the Friday, while the bookings they made before it go
  on counting against the household. Nobody gets a fresh week's allowance out of
  somebody moving out. The weekly limit is counted over the calendar week the
  booking is for - Monday to Monday, as Sweden numbers its weeks - rather than the
  week the request happens to arrive in.

  Cancelling sets a status and never deletes. The record that a booking was made
  stays and is erased on the same clock as any other, and because the unique index
  covers live bookings only, cancelling is also what hands the hour back to the
  calendar. A resident cancels their own; the board cancels anybody's, and the
  entry names the board member who did it and the resident it was about.

  A resident's calendar says free or taken and never who holds a slot: which
  apartment has the laundry room at nine is personal data the board's own view is
  gated behind. A booking that is not the caller's, and an apartment they do not
  hold, are both answered exactly as one that does not exist, so neither endpoint
  can be used to enumerate the building or the calendar one identifier at a time.

- c229871: Confirm a booking by email, and tell the resident who made one when somebody
  else cancelled it.

  Two templates, both addressed to the resident who made the booking and to nobody
  else, in that resident's own language. The confirmation is what the pilot wants
  weekly for the guest apartment and the common room, where a claim is made days
  ahead and the message is what the resident keeps. The cancellation goes out only
  when the cancellation was not their own act: a resident who pressed cancel is
  telling themselves, while a resident whose guest apartment the board withdrew
  has no other way to find out before they open the calendar - which may be after
  the visitors have arrived. The test is the actor against the person who booked,
  not which of the two routes was used, so a board member cancelling their own
  booking through the board's half writes to nobody.

  Each message states the period in the terms its resource is booked in: a laundry
  hour as a date and two times, a common room as a date, a guest apartment as a
  check-in and a check-out. The times are formatted on the association's own
  clock, so a slot booked for seven in the morning is stated as seven in the
  morning on both of the two days a year that are 23 and 25 hours long.

  Both are sent after the transaction has committed, and a failure to send is
  logged rather than raised. A mail server that is down must not turn a booking
  that succeeded into a refusal: the slot is held by the database by then, and a
  resident who read a failure and pressed the button again would be refused for a
  period their own booking is holding. The address is decrypted for the length of
  one send and never held, and the log line names the booking and the class of the
  failure - never the recipient, because a mail server's rejection quotes the
  envelope it was given.

  Mail only, and no text message. An SMS costs the association money per segment
  and a laundry hour is not worth one until somebody asks.

- e50dd93: Refuse a bookable resource whose name or description carries a personal
  identity number.

  The two free-text fields on a resource are the board's own words, and they reach
  further than the settings form they are typed on: every resident reads the name
  and the description on the booking calendar, and the name goes into the
  confirmation mail sent once a booking commits and the notice sent when somebody
  else cancels one. A number pasted there is copied out to mailboxes the
  association does not control, which is the one disclosure no later edit reaches.
  A resource is also the longest-lived row in the module, withdrawn rather than
  deleted and outside every purge scope, because the bookings made against it say
  what they were for only through it.

  There is no publication step to hang the scan on, unlike a news item or an event
  series: a resource is on every resident's calendar from the moment it exists. So
  both fields are scanned on the way in and on every later edit, on the one method
  the two write paths share, and a resource that already exists is not a way round
  the guard.

  The refusal is its own reason code and names the fields it was found in, in the
  words the form above them uses, and never the value. The response carries the
  character offset as well because nothing else could report it, and the settings
  panel declines to render it: a character position in a textarea is not something
  a person acts on, and the field is.

- 912bf9e: Add the bookable resources the association offers, the booking table behind
  them, and the retention story that has to come with it.

  A bookable resource is whatever the house has: a laundry room, the common room,
  the guest apartment, a sauna, a roof terrace. The board names its own, the way
  it names its issue types, because a fixed list of kinds would have been wrong on
  the day it shipped and every entry on it would have been a synonym for one of
  the three ways a thing is actually booked. Those three are what the application
  knows about. Fixed-length slots inside a day, with an opening and a closing time

  - the laundry room, the sauna. One whole day at a time - the common room. A
    check-in and a check-out date spanning nights - the guest apartment.

  The slot length has to divide the opening hours into whole slots, and a
  whole-day resource may not carry opening hours at all. Both are refused when the
  board saves the resource rather than left for slot generation to work around: a
  board told at the moment it can fix the problem is better served than a resident
  meeting a forty-minute laundry slot at the end of the day, and a setting that
  can be changed with no effect is the worst kind of setting there is.

  Each resource carries two limits on what one apartment may hold, and each is set
  on its own. One bounds how many unstarted bookings an apartment may hold at once,
  which is what stops one of them reserving every Saturday until spring. The other
  bounds how many it may make in a calendar week. Either may be left empty for no
  limit, because they answer different questions: a sauna is often capped per week
  and not at all concurrently, and a guest apartment the other way round. A
  resource is withdrawn from booking and never deleted, so the bookings already
  made against it keep saying what they were for.

  How a resource is booked cannot be rewritten while somebody still holds a
  booking of it. A booking carries the times it was made for and not a reference
  to a slot, so turning a laundry room into a whole-day resource would leave the
  resident who holds Tuesday evening holding a period the house no longer offers -
  one the calendar cannot draw and the quota cannot count. Whether those bookings
  should be cancelled is the board's decision, taken booking by booking, and not
  the silent effect of saving a settings form. The name, the description and the
  two limits stay editable throughout, and a resource nobody holds a future
  booking on is the board's to reconfigure: rewriting the slots does not make last
  March untrue.

  The double booking is refused by the database. A partial unique index holds one
  live booking per resource and start time, so two residents claiming the same
  laundry hour in the same instant are sorted out by Postgres rather than by a
  read the application took a moment earlier. It is partial because a cancelled
  booking has to give its period back, whether that is a laundry hour or a week in
  the guest apartment: a full constraint would mean a time somebody changed their
  mind about could never be booked by anyone again.

  The retention promise lands with the table rather than after it. A booking says
  which person, in which apartment, held which period, and the purpose that is
  held for ends when the booked period does - so a booking is erased a year after
  it ends, on its own clock and not on the one that governs a former resident's
  contact details. Somebody who still lives here has no more use for last March's
  sauna hour than somebody who has left. A nightly job does the erasing, one
  person per transaction, and a legal hold stops it for the person it stands
  against: a dispute that keeps somebody's contact details keeps the bookings the
  dispute may be about. The data subject access report lists every booking a
  person still has on file and states, per row, the earliest date the purge can
  reach it - the earliest, because a legal hold defers it, and the report says on
  the same page whether one stands. Bookings erased in an earlier year are not on
  it: what remains of them is the entry in the audit log saying how many went and
  when.

  Three capabilities carry the module. Booking and cancelling one's own is
  residents' and the board's; seeing and cancelling anyone's, and configuring the
  catalogue, are the board's. The property manager is granted none of them: they
  handle the association's issues, they do not live in the building, and a laundry
  hour held by an external contractor is an hour taken from a household.

- 53f44cf: Refuse to start when a boolean setting is neither "true" nor "false".

  `OPENBRF_ACTIONS_READ_ONLY`, `OPENBRF_PLUGINS_ENABLED`,
  `OPENBRF_UNCURATED_PLUGINS_ENABLED`, `OPENBRF_PLUGINS_REINSTALL_ON_BOOT` and
  `OPENBRF_S3_FORCE_PATH_STYLE` read any value other than the exact word `true` as
  false, so `OPENBRF_ACTIONS_READ_ONLY=1` started an instance that still wrote,
  without a word. They now take `true` or `false` in any case, an empty value
  still means the default, and anything else stops the boot with the variable
  named.

  An instance that sets one of these to anything else, such as `1` or `yes`,
  has to change it to `true` or `false` before it upgrades.

- dd64599: Add the broker information page, generated from facts the board records about
  the association.

  A broker asks every housing cooperative the same questions before a sale, and a
  board that has no page to point at answers them by email one at a time. The
  board records them once instead: the property designation, the year the
  building went up, whether the association owns its land or holds it on a site
  leasehold, how the fee is set and what it covers, the transfer and pledge fees
  and who pays them, whether a legal person may be a member, parking, storage,
  and the renovations of note. The website serves those facts at /maklarinfo,
  and at /broker for a cooperative that keeps its site in English.

  The page is generated from the recorded facts and from nothing else. Beside
  them it carries the association's name and organisation number, which are the
  cooperative's own legal-person facts, and the number of apartments, which is a
  count. That count is the one value on the page no board member typed, and it is
  an aggregate over the apartment register: a number of rows, never a row.
  Nothing personal and nothing per-apartment reaches the page, and nothing could:
  the code that renders it imports neither the member register, the address book
  nor the encryption layer, so there is no path from this page to a resident's
  details rather than merely no query written today. The paid transactional
  broker extract is a different product for exactly that reason - it needs
  per-apartment facts this page may not hold.

  A question the board has not answered is not on the page. There is no empty
  label, no dash and no "not recorded": the person reading the page cannot go and
  fill the gap in, so raising the question at them is worse than leaving it out,
  and a whole group whose facts are all unanswered loses its heading with them.
  Clearing a fact takes it off the page again in the same way. A yes or a no is
  published as the sentence it means - "the association owns the land" rather
  than a tick - so it stands on its own wherever a broker copies it to. And the
  board's form has a third answer beside yes and no, because "the board has not
  decided" is a real state and an unticked box would publish a decision nobody
  made.

  The page exists from the moment the feature ships. An association that has
  recorded nothing gets a page carrying its name and organisation number rather
  than an address that answers "no such page" until somebody saves a form - a
  broker who was sent the address once has no reason to try it twice.

  The association's menu can point at it. The broker information page is one of
  the destinations the menu editor offers, and it is offered for real rather than
  reserved: the page is public and no setting turns it on, so an entry a board
  adds is an entry every visitor can follow, signed in or not. The page carries
  the same menu, header and footer as the pages the board writes, by the same
  code, so the website has one chrome and not two.

  Everything on the page is free text a board member typed, published at an
  address anyone can open, so a personal identity number in any of the fields is
  refused on the way in, exactly as it is on a page. The refusal names the field
  and where in it the number sits, and never the number. The page is answered in
  the association's own language rather than the visitor's, because the facts are
  stored as the board wrote them and are never translated; a Swedish fee policy
  under an English question would be a document whose language is only half
  declared. Like every page on the association's website it runs no script, sets
  no cookie and fetches nothing from a third party.

- fc9dba7: Add group chats: a room the house makes for itself, and the one way the board
  reaches one.

  A group is a named set of people with a chat of its own - a work party, a garden
  committee, a stairwell - and it is made by whoever wants one rather than curated
  by the board. Somebody who lives here types a name and the room exists: no
  approval, no appointment, and no capability beyond the one that opens the chat's
  endpoints, which is now every resident's. Nobody administers it either. Anybody
  in the room may put another resident into it, and each may take only themselves
  out, because a private room in which one member could throw out another would be
  a tribunal and whoever pressed first would be its judge. Whoever made the room is
  recorded on it and that record grants nothing.

  Membership is written down and tested against a live residency, so a place in a
  group ends the day somebody moves out, exactly as a booking allowance bites on
  the day it says. Nobody strikes a name off a list for that: the register decides
  it, and what the person wrote stays in the room, attributed exactly as before and
  on the clock it was always on.

  A group is invisible to somebody who is not in it. It is on no list, no screen
  carries a count of rooms, and asked for by identifier it is refused exactly as a
  room that does not exist - the same status and the same body - so the identifier
  space cannot be walked to learn what rooms a cooperative has made. The messages
  are the board chat's in every other respect: written once and never edited,
  deleted or withdrawn, scanned for a personal identity number on the way in, read
  a page at a time from the newest end, delivered by the same four-second poll, and
  erased a year after each was written. A group whose last message the clock has
  reached is erased with the list of who was in it, because that list would
  otherwise be the one thing in the chat with no clock of its own.

  The board reaches a group only through a report from inside it, which is ADR 0012. A member of the room reports one message; the report is what makes that
  message readable by the board and makes nothing else readable - not the message
  before it, not the room's other members, not the room. The board reads a queue of
  reported messages and answers each one of two ways: struck through, or left
  standing. Every moderation route takes a report identifier and none takes a room
  or a message, so a board member cannot strike a message nobody reported and
  cannot ask about a room at all. Striking withholds and never erases: the message
  stays where it is with its author's name on it, its text withheld from the others
  in the room and readable to whoever wrote it, on the retention clock it was
  always on, and nothing clears the strike. It sits behind a capability of the
  chat's own rather than the one the association publishes its website under,
  because a group publishes nothing - and behind a board seat as well, because the
  instance's administrator holds every capability, holds no seat and is already
  refused the board's own room.

  What is audited is the acts that change who can read a room - making one, putting
  somebody in, somebody leaving, and striking a message through. Writing a message
  is not, for the reason the board chat gives, and neither is reporting one: the
  report row holds who reported what, when and what was decided, and unlike an
  audit entry it is erased with the message it is about. A person's own access
  report carries the groups they are in, the messages they wrote in each with the
  day any was struck, and the reports they made or answered - never the message
  somebody else wrote, which is that person's data rather than theirs.

- d4d763d: Do the rest of what a controller has to do: the record of processing
  activities, the breach register, processor agreements, the privacy notice
  measured against art. 13, and the requests a person makes about their own data.

  The hard half of data protection was already here - encryption at rest, access
  control, masking, the audit log, retention with a nightly purge, the data
  subject access report. What was missing was the half a supervisory authority
  asks to see: the records. A board could run this platform lawfully and have
  nothing written down to show for it. This is the writing down, and it is in
  Core and free, because what an association must do to process personal data
  lawfully is part of the product rather than something to pay for.

  **The record of processing activities (art. 30) is seeded, not typed in.** A
  board cannot be expected to enumerate its own processings from memory, and a
  register somebody typed once goes stale the day a setting changes. So the
  instance writes down what it already knows it does - the statutory registers,
  the address book, the mailings, the issue queue, the document archive, the
  bookings, the events, the meetings, sixteen processings in all - each with its
  purpose, its legal basis, the categories of personal data and of people, the
  recipients, the retention and the security measures. Every one of them is
  editable and the board can add its own, because an association processes things
  outside the application too. The controller's contact details, the joint
  controller where there is one, and the data protection officer where the
  association has appointed one are recorded once and read from there.

  **The breach register runs a clock rather than holding a form.** GDPR art. 33
  starts counting from the moment the board became aware of a breach, which is
  not the moment somebody sat down to write it up, so those two dates are
  separate columns and the deadline is derived from the first. The board is
  mailed when a day of the 72 hours is left. Recording a breach is one act;
  deciding it is another, and the decision carries its ground: IMY is notified,
  or it is not because the breach is unlikely to result in a risk to the people
  concerned (art. 33(1)); the people affected are told (art. 34(1)), or they are
  not under one of the exceptions in art. 34(3). A record whose notification went
  out after 72 hours will not close without the reasons for the delay art. 33(1)
  requires. The notification itself goes through IMY's own e-service - what
  belongs here is the record, the clock and the evidence of the decision.

  **A recipient is classified before an agreement is asked for.** Not everything
  that receives personal data is a processor, and asking a board to sign an
  art. 28 agreement with its own hard drive would teach it that these records are
  paperwork. So each recipient the instance actually has - read from the
  configuration rather than from a list somebody maintains - is classified first:
  a processor, no processor because it runs on the association's own
  infrastructure, or an independent controller. Only a processor needs an
  agreement, with the terms art. 28(3) requires and the prior authorisation of
  sub-processors art. 28(2) requires. The SMTP server, the SMS provider and the
  object storage are each there when they exist and absent when they do not; the
  local disk is listed with "no processor" already suggested; and hosting is
  listed because somebody runs the machine and only the board knows who. A plugin
  is a recipient too, and the consent step now asks the one question the instance
  cannot answer for itself: whether this plugin sends personal data outside the
  instance, and to whom.

  **The privacy notice is measured against art. 13 rather than assumed to
  satisfy it.** The seeded page grew from six headings to fifteen - the legal
  basis behind each purpose, the legitimate interest where that is the basis, the
  recipients, transfers to a third country, automated decisions with the logic
  involved and what they mean for the person, the data protection officer, the
  right to withdraw a consent, whether giving the data is a statutory or a
  contractual requirement and what follows from not giving it, and the right to
  complain to IMY. The screen names the headings the published page has not
  answered yet and can append the missing ones for the board to fill in, and the
  controller's contact details are a block the page reads from the instance
  rather than something retyped into prose that then goes stale.

  **A person can ask for more than a copy.** Erasure ahead of the retention
  window on one of the grounds in art. 17(1), granted only where none of the
  exceptions in art. 17(3) applies - which for a cooperative means no statutory
  duty to keep the record and no legal claim, the ground a legal hold already
  records. An objection to a processing (art. 21). A restriction of it
  (art. 18). Each is recorded against the person with the ground the board relied
  on, answered inside the month art. 12(3) allows - a due date derived from the
  calendar rather than stored - and each reaches the screens the processing
  actually runs from: an objection stops the news mail and the text message, a
  granted erasure brings the nightly purge forward to the next run, and a
  restriction stops every purge from touching the person at all, because art.
  18(2) says the association may store the data, which makes erasing it the one
  act the person asked it not to perform.

  **Data portability (art. 20) hands the person a file.** A machine-readable
  export of what they gave the association under the membership contract or under
  their consent, and nothing else: no statutory register content, no audit trail,
  no personal identity number, no legal holds. It is separate from the data
  subject access report, which is a printed document by design and stays one. The
  export says in words that it is handed to the person to transmit themselves,
  because a direct transfer to another controller under art. 20(2) is required
  only where technically feasible and no receiving standard exists between
  housing cooperative platforms.

  **The nightly purge reaches issues and the document archive.** Both are service
  tier and both were listed on the access report without ever being erased. An
  issue or a document is detached from the person rather than deleted: the link
  and the personal data on the row go, the record stays. The description is not
  rewritten - it is free text the reporter wrote about the building, it is the
  record of the problem, and a job editing prose on a schedule would be the
  association quietly editing its own history. A report filed through the public
  form is keyed to nobody, so no person's clock would ever reach it; it is
  detached on a clock of its own, a year after the board closed it.

  **One screen, and a strip at the top of it that answers "do we owe anybody
  anything today".** Four sentences rather than four numbers, each reading as a
  word when it is zero, because a board that has nothing waiting should be told
  so - an empty strip looks like a screen that has not finished loading.

  Everything here is service tier and inside the retention policy, except the
  audit entries, which are outside every purge as they have always been. The
  statutory registers are untouched.

- a0ee312: Move every dependency, container image and pinned action to its current
  release, and clear the deprecations that came with them.

  NestJS 12 ships as ES modules, and its package no longer lists its own
  manifest in its exports map. The plugin resolution bridge asked for
  `@nestjs/common/package.json` to find the directory a shared package resolved
  from, so under v12 that question had no answer: the bridge reported the host's
  `node_modules` as unlocatable, and the identity check that refuses a plugin
  carrying its own copy of NestJS resolved nothing and therefore found nothing to
  refuse. Both now resolve the package entry and walk up to the `node_modules`
  that encloses it, which is a question every package can answer whatever it
  ships and however deep its exports map points. The bridge itself is unchanged -
  CommonJS resolution still honours `NODE_PATH`, and a required ES module still
  lands in the one module cache, so a plugin still gets the host's NestJS and not
  a second one.

  `@nestjs/platform-fastify` and the API now agree on one Fastify version, so
  only one copy of its type declarations is in the tree and multipart
  registration no longer needs to be cast onto a signature it already had.

  The plugin contract's peer range moves to NestJS 12, and the reference plugin
  fixture with it. A plugin still built against NestJS 11 has to move with it:
  the host provides the copy a plugin resolves, so a plugin declaring the older
  peer now conflicts with the host it would be installed into, and one carrying
  its own copy is skipped at boot by the identity check rather than registered.
  Rebuild against `@nestjs/common` 12 and widen the peer range to `^12.0.0`.

  Nodemailer 10 carries its own type declarations, so the separate `@types`
  package is gone. `better-sqlite3` - which arrives as an optional peer, is never
  loaded, and is never compiled - is pinned to the major that dropped the
  unmaintained `prebuild-install`, which was the last deprecation warning on
  install. Prisma stays on 7.10.0: its `latest` tag currently points at a release
  candidate that `@prisma/client` has no counterpart for.

- 56bedd9: Refuse, before the migrations run, a guard trigger that is missing, switched
  off or calls a rewritten function, a role that is a member of the schema
  owner, a setting stored for the owner or the database that is not known to be
  harmless, and another role's ownership of or CREATE on the database.

  The trigger check compared the triggers that are there with the ones Open BRF
  creates, and looked for other roles' functions, grants and schemas. What the
  schema owner can do itself left nothing for it to find: dropping a guard,
  switching one off, or rewriting the function it calls with
  `CREATE OR REPLACE FUNCTION`, which keeps the function's owner and every
  trigger that calls it. A role that is a member of the owner can do all of
  that as the owner.

  - `scripts/check-triggers.mjs` now stops on a trigger that a migration which
    has run created and that is gone, and on one that does not fire as it was
    created (disabled, or made a replica or an always trigger). The trigger on
    `pgboss.queue` is not looked for: the job schema install puts it back on
    every deploy.
  - It stops on a function a guard trigger calls whose language, settings,
    `SECURITY DEFINER` or body are not those the latest migration that has run
    gave it, an earlier migration's form included.
  - It stops on a `public._prisma_migrations` that is not a table the schema
    owner owns, that forces row-level security, under which a policy could
    hide the migrations that created a guard, or that has a parent or a child
    table, into which a migration's row could be moved where Prisma still
    counts it as applied. It reads that table with `row_security` off, so that
    a policy fails the read rather than running.
  - It stops while a role other than a superuser is a member of the schema
    owner, directly or through another role. That includes a role holding only
    `ADMIN OPTION`, as one that created the owner without being a superuser does
    on PostgreSQL 16 and later: it can grant itself the owner's privileges at
    any time. A member with none of these options is refused too: a role
    holding `ADMIN OPTION` can let it act as the owner. `docs/deployment.md`
    shows how an administrator without a superuser, as on a managed server,
    creates an owner no role is left a member of.
  - It stops on a setting stored for the schema owner (`ALTER ROLE ... SET`, in
    every database or in this one) or for the database (`ALTER DATABASE ...
SET`): each applies to the migrations' sessions. Settings of memory, time
    limits and planner costs, `TimeZone` and `application_name` pass; any other
    is refused, `search_path`, `session_replication_role` and
    `transform_null_equals` among them, so that one nobody has looked at yet
    stops the deploy rather than slipping past it.
  - It stops while the database belongs to a role other than the schema owner
    itself, and while a role other than the owner, or `PUBLIC`, holds `CREATE`
    on the database. Step 6 accepted a database owned by a role the owner is a
    member of.
  - A schema named after the schema owner, which `"$user"` puts before `public`
    on the owner's search path, is checked as `public` is: its owner, `CREATE`
    on it, and the functions and operators in it.
  - Every catalog query pins `search_path` to `pg_catalog, pg_temp`, and the job
    schema install's connections do the same, so pg-boss's SQL looks up names in
    the built-in catalog alone.
  - The message a passing check prints says how many guard triggers it looked
    for, that the one on `pgboss.queue` is left to the job schema install, and
    that a superuser can still act as the owner.

  The check sees the database as it is at deploy time. A guard switched off and
  back on between two deploys, by someone holding the owner's password, leaves
  nothing for it to find. `docs/deployment.md` says how to log that with
  `log_statement = 'ddl'` or `pgaudit`.

  **Upgrade note:** a deployment that runs only the bundled steps sees no change.
  An instance on a shared server may now stop before the migrations:

  - `The database ... belongs to ..., not the schema owner.`: as a superuser,
    `ALTER DATABASE <database> OWNER TO <schema owner>`. A database owned by a
    group role the owner is a member of stops here too.
  - `... holds CREATE on the database ...`: as the role that granted it,
    `REVOKE CREATE ON DATABASE <database> FROM <role>`, then look at the schemas
    and extensions that role created (`\dn` and `\dx` in psql).
  - `... can act as the schema owner ...` or `... is a member of the schema
owner ...`: find out who granted the membership and what the role did, then
    `REVOKE <schema owner> FROM <role>` as a superuser or as the role that
    granted it. An administrator that created the owner without being a
    superuser holds `ADMIN OPTION` on it, which only a superuser can revoke.
    Where nobody holds one, as on a managed server, move the instance to an
    owner created by a role that is dropped afterwards, as
    `docs/deployment.md` ("Several instances on one database server") shows.
  - `... has the stored setting ...`: as the schema owner,
    `ALTER ROLE <schema owner> RESET <setting>`, with `IN DATABASE <database>`
    where the message names the owner in the database, or
    `ALTER DATABASE <database> RESET <setting>`.
  - `public._prisma_migrations ... forces row-level security ...`: find out who
    turned it on and whether rows were taken out, then, as the schema owner,
    drop its policies and run `ALTER TABLE public._prisma_migrations
NO FORCE ROW LEVEL SECURITY, DISABLE ROW LEVEL SECURITY`.
  - `public._prisma_migrations ... takes part in table inheritance ...`: find
    out who did it and which rows were moved, then, as the schema owner, copy
    the migrations' rows in a child back into `public._prisma_migrations` and
    run `ALTER TABLE <child> NO INHERIT public._prisma_migrations`, or
    `ALTER TABLE public._prisma_migrations NO INHERIT <parent>`.
  - `... is missing the trigger ...`, `... does not fire as it was created ...`
    or `... calling a function that is not as the migrations ... wrote it ...`:
    someone changed a guard with the schema owner's privileges. Find out who
    and what was written while it was off, then put the trigger or function
    back from the migration under `prisma/migrations` that wrote it.

- 1feeede: Refuse functions and operators of other roles in the application's schemas,
  other roles' ownership of those schemas, and other roles' CREATE on them,
  before the migrations run.

  A name a migration or pg-boss calls without a schema can resolve to a function
  or operator in `public` or `pgboss`. PostgreSQL takes the best match for the
  arguments from every schema on the search path, so one there can win over the
  built-in, and it runs as the caller: the schema owner during the migrations
  among them. A database restored from a dump made before PostgreSQL 15 lets
  every role create one in `public`, and the hardening revokes that only after
  the migrations have run.

  - `scripts/check-triggers.mjs` now also stops on a function, procedure,
    aggregate or operator in `public` or `pgboss` that a role other than the
    schema owner owns, while such a role owns either schema, and while such a
    role, or `PUBLIC`, holds `CREATE` on either schema or is given it by the
    owner's default privileges. A superuser may own either schema, and so may
    `pg_database_owner` while the schema owner or a superuser owns the database.
    A function or
    operator an extension installed passes where a superuser owns it, as the
    bootstrap superuser does for a trusted extension a role installed; one of
    another role's does not pass for belonging to an extension, since whoever
    owns the extension can add their own to it with `ALTER EXTENSION ... ADD`.
  - Every catalog query the check runs pins `search_path` to `pg_catalog`. Only
    the first one did, so the others could call a function in `public` that
    matched their arguments better than the built-in, as the owner.

  **Upgrade note:** a deployment that runs only the bundled steps sees no change.
  One whose database was restored from a dump made before PostgreSQL 15 may still
  give `PUBLIC` `CREATE` on `public`, and now stops before the migrations with
  `PUBLIC holds CREATE in public.` in the log. Run
  `REVOKE CREATE ON SCHEMA public FROM PUBLIC` as the schema owner, look at any
  function or operator the log names, and deploy again. An instance on a shared
  server whose `public` or `pgboss` belongs to another role stops with
  `... belongs to ..., not the schema owner.`: hand the schema to the schema
  owner with `ALTER SCHEMA ... OWNER TO` as a superuser, look at what that role
  put there, and deploy again.

- 2bfc19e: Harden how an instance is deployed and which database roles it uses.

  The deploy steps - the field encryption key on a first boot, migrations, the
  job queue schema and the application's own database role - now run in a
  `migrate` service of their own, which exits once they have run; the
  application starts only after it succeeded. The application's container is no
  longer given the schema owner's or the superuser's credentials at all, and
  refuses to start if it is. All of the instance's containers run with a
  read-only root filesystem, no capabilities and `no-new-privileges`, and the
  code in the image is owned by root, so the user they run as can write to
  `/data` and a scratch `/tmp`, and nowhere else.

  Migrations now run as `openbrf_owner` (or the name `OWNER_DB_USER` gives), a
  schema owner that is not a superuser. A `schema-owner` service creates it as
  the superuser on every `up`, before the migrate service, and on an instance
  installed before it existed moves the superuser's tables to it; anything
  another role owns in the application's schemas it names and leaves for the
  operator to look at. An existing instance first replaces its
  `docker-compose.prod.yml` with the release's, and fetches the release's
  `env.production.example` to compare, since the new image does not start under
  the old file; then it sets the new, required `OWNER_DB_PASSWORD`, and upgrades
  with `pull` and `up -d` (`docs/deployment.md`, "Upgrading to a separate schema
  owner"). An instance on a database server of its own
  has its owner created by that server's administrator, and runs the migrate
  service and then the application (`docs/deployment.md`). One that already ran
  on such a server moves `POSTGRES_USER` and `POSTGRES_PASSWORD` to
  `OWNER_DB_USER` and `OWNER_DB_PASSWORD` with the same values, does not run the
  `schema-owner` service, and runs `run --rm --no-deps migrate` before
  `up -d --no-deps app` (`docs/deployment.md`, "An instance on a shared database
  server"). The `schema-owner` service refuses to run as a role that is not a
  superuser, and names that section. An operator who
  manages the runtime role themselves (`DATABASE_URL_RUNTIME`) constrains it
  once, as `docs/deployment.md`, "Upgrading to a separate schema owner",
  describes, since the start check below refuses a role that an earlier release
  let write the migration history.

  The application's role can no longer write the migration history or the job
  schema's version, and no longer holds `CREATE` on the job schema, which no
  queue needed. And in production the application now asks the database, before
  it starts anything, whether the role it connected as is a constrained one, and
  refuses to serve as a superuser, a role that owns anything in the
  application's schemas, a member of another role, a role that can create objects
  in those schemas, or one holding any privilege the hardening takes
  away on the statutory archive, the migration history or the job schema's
  version.

- c4c4280: Make the platform deployable, and test it the way it deploys.

  A multi-stage image builds the web client and the API and serves both from one
  container, so the session cookie the browser holds belongs to the same origin as
  the API that issued it. `docker-compose.prod.yml` puts a PostgreSQL beside it
  with named volumes, health checks on both and a slot for the catalog token.

  The entrypoint does everything a deploy needs before the application listens: it
  assembles both database connection URLs from their parts, so a password holding
  `:`, `/`, `@`, `?` or `#` is percent-encoded rather than pointing the instance
  at something else; it provisions the field encryption key on a genuine first
  boot and refuses to invent one on any later boot; it applies migrations,
  installs the job queue schema, and creates the constrained database role the
  application connects as - so the application never owns the tables whose
  triggers keep the member register and the audit log append-only. The owner's
  credentials go no further than those steps: neither password is ever a process
  argument, and both are dropped from the environment before the server starts,
  so the process that serves requests holds the constrained connection alone. All
  of it is idempotent, so an upgrade is a newer image - `docker compose -f
docker-compose.prod.yml --env-file .env.production build` while none is
  published - followed by the same `up -d` that started the instance.

  That role holds `CREATE` on the job queue's own schema and nowhere else, so a
  feature - or an installed plugin - can declare a background queue while the
  application is running, without a deploy step and without reaching the schema
  the statutory registers live in.

  Signing in with a passkey is now something the interface offers, not only
  something the API supports. It asks for no email address, because the credential
  is discoverable, and for no one-time code, because a passkey is
  phishing-resistant.

- 711c214: A plugin or theme the catalog has deprecated can no longer be installed anew.

  The catalog marks an entry `deprecated` when its curator withdraws it without
  delisting it. Until now that only put "No longer maintained" beside the entry,
  and the install went ahead as before. A first install of a deprecated entry is
  now refused with the reason `entry-deprecated` before anything is downloaded or
  recorded. Both screens disable its install button, and `openbrf plugin add`
  refuses it before printing the consent, in a dry run too. A theme composed on
  the instance under the same id does not count as the entry installed.

  An instance that already has the plugin or theme can still install it again and
  take its updates, so a board is never left unable to repair something it
  already runs.

- 2b6e8f1: Add the document archive: the association's own documents, each for a stated
  audience.

  The board files the bylaws, the minutes, the house rules and the annual report
  into binders it names itself, and gives each document one of three audiences:
  the board, the members, or anyone. There is no separate capability for
  reading: the audience on the document is the whole of the rule, and which
  audiences a person is inside follows from who they are - the members' shelf
  from the tenant-ownership they hold, the board's from the capability that
  manages the archive, and the published one from nothing at all. So the board
  sees all three shelves, a member sees theirs and the published one, a resident
  who is not a member sees what is published, and a visitor with no account can
  open a published document at its own address.

  The audience is enforced on the file rather than only on the list, for all
  three of them. Filing a document writes the same decision onto the stored
  file, and changing it later rewrites both in one transaction: a document taken
  off the public shelf takes its file off the street in the same breath, instead
  of staying fetchable by anyone who had seen the address while it was
  published. A document kept to the members is readable by whoever holds a
  tenant-ownership, and by the board and an administrator who manage the archive
  on their behalf - not by every account that happens to be signed in, so a
  resident who is not a member gains nothing from holding the address. A
  document kept to the board is narrowed further still, to the capability that
  manages the archive, and that narrowing is what puts every opening of one in
  the audit log. The members' shelf is deliberately left out of that record:
  members read their own association's papers as a matter of course, and a row
  for each would say who read what rather than hold anyone to account. Documents
  are served by the route that already serves the association's mark, so a
  public document sets no cookie and no second serving path exists to get the
  decision wrong differently.

  Minutes of a general meeting name the members who spoke and how they voted, so
  they go to the members: choosing the minutes binder takes a document off the
  public shelf, and publishing a particular set is then a second, deliberate
  answer. New documents are the members' by default, in the interface and in the
  database column both.

  Managing the archive is a new capability, granted to the board and to an
  administrator. Uploads accept documents as PDF beside the images the platform
  already took, identified from their own bytes like everything else that is
  stored - a file that opens as a document but does not close as one is refused,
  whatever it is named.

- f9faabe: Show the board what a granted erasure request is waiting on.

  A granted erasure request the purge left open said why only in the run's log
  line and its audit entry. The person's page showed "granted" and nothing else,
  so a board could not see that a legal hold, an open motion or key order, or a
  consented subletting that still runs was holding it, or that recording the
  subletting's end would let it go.

  The board's person view (`GET /api/address-book/persons/:id`) now carries
  `erasureWaitingOn` for the granted, unexecuted erasure: the status (`blocked`
  or `incomplete`), the rule that refuses the purge if one does, each domain
  still holding rows with its owed and kept counts, and `lettingLastDay`, the
  last day of a consented subletting that keeps a subletting application (the
  recorded end where there is one, otherwise the period's). The request's row
  says the same in the board's language. It is computed on every read and never
  stored. Like the log line, it carries counts and a rule, never a row.

  The purge's run account and the screen now read an open request through one
  function, so they cannot disagree about why it is open. The log line keeps
  its words.

- bb70934: Give a called-off date a way back, bound the board's calendar to a period, and
  let the server decide whether a date has begun and who it was published to.

  **A date the board called off can be put back.** Removing a series is refused the
  moment anybody has signed up to one of its dates, and nothing anywhere cleared
  `cancelledAt`, so a board that called off the wrong date had no way back at all -
  not clearing it, not removing the series, not re-entering the date, because the
  unique index on the series and the start instant is the row already sitting
  there. Reinstating is its own act with its own route, its own reason codes and
  its own entry in the audit log: taking an announcement back and making one again
  are two decisions, and a reader of the log has to be able to say which an entry
  was. It is refused for a date that was never called off, for one the clock has
  passed - it did not go ahead, and the calendar cannot say afterwards that it
  did - and for one whose series has been removed since, whose rows cascaded with
  it.

  **A place freed while the date was off does not come back with it.** Somebody who
  stood down because the date was called off has stood down: the withdrawal is a
  date on their own row, taken by them or by the board on their behalf, and the
  reinstatement neither reads it nor writes it. The place they gave back is free
  from the moment they gave it and is takeable again by anybody including them, at
  the back of the queue, which is what a withdrawal means everywhere else in the
  module. The screen says so in the sentence it shows afterwards, the schema says
  so on the column, and two tests hold it - one over the endpoints, and one whose
  sign-up table throws on every method so that a service reaching for it fails
  rather than passing an assertion about a row nothing looked at.

  **The board's list answers for a period.** It had no bound and selected every
  date of every series: the recurrence rule caps one series at 105 dates, but
  nothing caps how many series a house enters, so the read grew without limit as
  the module was used as intended. It now takes a window of local days, bounded to
  the same two months the booking calendar answers for and defaulting to that
  widest window from today, and the window is applied to the dates as well as to
  which series come back. A series with no date in the period is not in the answer,
  and the board reaches any other period by stating one - the panel states one on
  every read and moves it a whole period at a time, so no date falls between one
  period and the next. Each card states how many dates the series has altogether,
  from the database's own count, so a period showing three of twelve never reads as
  a series of three.

  **Whether a date has begun is the server's answer.** The resident's calendar
  carried the instants and left the comparison to the browser, while the booking
  calendar has been sending `PAST` as one of four states per slot all along. The
  row now carries the fact, decided from the same clock the claim is refused on,
  and the panels read it - which is also what decides whether a called-off date is
  still one that can be put back. The browser-side comparison is gone, and so is
  the pinned clock its tests needed.

  **A resident can see whether the same words are on the street.** The audience a
  series was published to now travels on the application's own calendar, so
  somebody entitled to read the members' events and the public ones both can tell
  which is in front of them, and a board that published one to the street by
  mistake finds out from a screen rather than from a neighbour. The public
  website's payload gains nothing: who may read an event there is decided from
  whether the request carried a session and from nothing else, which is what keeps
  that rule in one line of one query, and a test asserts the whole key set of the
  public date so a field describing an audience cannot arrive there unnoticed.

- 86b8cbc: Add sign-up to the event calendar: a resident puts their name down for one date,
  stands down again, and the board sees who is coming.

  A sign-up attaches to one occurrence and never to the event, which is the whole
  reason the dates are rows. Somebody signs up for the cleaning day on the 18th of
  April, and the places are counted against that date - so twenty places at each of
  a year's cleaning days is twenty places twelve times over rather than twenty for
  the year. One row per person and occurrence, for as long as it is kept - the
  purge below is what ends it, and nothing before then writes a second one.

  The place is claimed rather than checked for. One sign-up per person and date is
  a statement about a single row, so a unique index holds it and a second claim
  matches nothing instead of writing a second row. The capacity is not that shape:
  "at most twenty standing sign-ups for this date" is a statement about a set of
  rows measured against a number stored on the event, which no constraint can
  express and which no single statement can settle either - at the isolation level
  everything here runs at, a statement counting rows cannot see a claim that
  committed while it was waiting. So a lock keyed on the occurrence is taken before
  anything the decision rests on is read, and the count behind it is decisive
  rather than true-when-it-was-taken. Two residents claiming the last place in the
  same instant produce one place taken, one refusal with the reason a read would
  have given, and one entry in the audit log.

  Standing down writes a date on the row and never deletes it. Who was expected at
  a cleaning day and who changed their mind are two different answers, and a
  deleted row can only give the first by omission. It is also what makes the place
  countable: the places taken are the sign-ups without a withdrawal date, so
  standing down frees a place the moment it is recorded and a neighbour can take
  it with nothing recomputed. Signing up again reopens the same row - at the back
  of the queue, because somebody who gave a place up has no claim on it.

  A withdrawal does not hold a date. The board may reshape or remove an event
  somebody stood down from, which is the difference between recording a date and
  locking the calendar; a sign-up nobody withdrew does hold its date, including one
  the board has already called off, because calling a date off is a statement about
  the association's plan and not about who is still expecting to be there. The
  board's way out is a withdrawal on that person's behalf, which is one recorded
  act per person rather than the silent effect of saving a form.

  How many places are gone is what the calendar a resident reads carries. Who has
  taken them is personal data about other residents and is behind the managing
  capability, on its own controller, and a person with protected personal data is
  on that roll-call as a place and never as a name - the statutory registers have a
  reason to print those names and a list read in a stairwell doorway has none. The
  ones who stood down stay on it with the date they did.

  Signing up is its own capability, held by residents and the board. It answers
  what a principal may do, which is a different question from whether they may edit
  their own record: somebody with an account and no residency holds the second and
  not the first.

  Every date this reports is the association's own. A midsummer party starting at
  half past midnight is on the 21st of June in Stockholm and on the 20th as an
  instant, and the day it is filed under is the one the notice in the stairwell
  says - on the screen, on the roll-call and on the access report alike.

  Both acts are in the audit log, carrying the identifiers, the date and the state
  of the places, and never what the event is called. A withdrawal names the person
  whose place it was as the subject whoever asked for it, so their own access
  report shows a withdrawal somebody else decided on.

  Same change: the access report gains a sign-up section stating each row's own
  erasure date, the withdrawals included, and a nightly purge erases a sign-up a
  year after the date it was for ended - on the occurrence's clock rather than the
  residency one, with a legal hold standing against the person stopping it both in
  the scan and inside the transaction that deletes.

- 1409de1: Cover the association's event calendar end to end against the production image,
  and tick it.

  The module has two halves written in different languages against different
  audiences - a screen behind a session, and a server-rendered website with no
  script on it - and everything worth proving here lies in the seam between them.
  Each half already had its own unit and integration coverage. What neither of
  them could say is that the same act reaches both.

  The board enters a cleaning day and a board meeting through its own form and
  publishes them to two different audiences: one field decides which, its default
  is the members, and the two cards then say which each series got. Entering one
  leaves a draft, because publication is a second act - it is what the audit log
  records and what the personal identity number scan guards.

  The street is then answered with exactly one of them, which is a stronger claim
  than the public one being there: a calendar showing everything would satisfy
  that. The cleaning day is on the month the address names, with how many places
  are gone beside it and nobody's name anywhere on the page, and the page runs no
  script, sets no cookie and asks no other company for a single byte - a typeface
  has to be among the subresources before "from this instance" means anything, so
  the assertion cannot be held by a page that fetched nothing. The way between
  months is two ordinary links. The members' meeting is not on the calendar for a
  visitor with no account and is on it for one signed in, at the same address; and
  asked for by its own address it is answered with the website's own not-found
  document, byte for byte the same one an address naming nothing produces, while
  the same address opens for the signed-in reader - which is what makes the
  refusal about the audience rather than about a broken identifier.

  A resident takes a place at a date and gives it up again, and the count beside
  the control is the server's answer both times: the row is read again from the
  instance between the two acts, so nothing asserted here is a row a click left
  behind. The last place then goes while somebody is looking at it - the refusal
  is reachable no other way, because a date whose places are gone is drawn as a
  statement rather than as a control. The 409 and its `occurrence-full` code are
  pinned beside the Swedish sentence the screen turns them into, the row the
  reader is looking at catches up in the same breath, and the instance is asked
  afterwards whether anything was written for them, because a screen that had
  simply never drawn a row would satisfy an assertion made against the page.

  And the roll-call, which is the one list in this module that names residents. It
  names the person who signed up, it keeps the one who stood down as somebody who
  stood down, and the resident carrying protected personal data is a place on it
  and never a name - asserted against the whole page, since an accessible name is
  text like any other. The board stands one named person down from the list it is
  reading and the place is counted back.

  Every date the suite works with is computed from the day the run happens, on the
  association's own clock, and which day a date belongs to is read from what the
  server answered rather than derived from an instant: an event at half past
  midnight is on one calendar day in Stockholm and on another in UTC, and the
  notice in the stairwell says the Stockholm one.

  ROADMAP: `[x] Event calendar with sign-ups`. Schema, API, screens, the public
  website and end-to-end coverage are all green, so the box ticks - and v1.1 is
  complete.

- 645c17c: Add the event calendar the board arranges: the event, the rule by which it
  repeats, and the dates it falls on.

  An event is a series rather than a date. It carries what the board calls it,
  what it is about, where it happens, which category the board sorts it under -
  free text, the way the issue types and the archive's binders are - and whether
  people may sign up, with how many places each date has. An event with no
  recurrence is an event with one date. There is no separate model for a one-off,
  no flag saying which kind it is and no second code path anywhere, because two
  paths would have been two sets of rules about publishing, editing and calling
  off, and the single-event one would have been the one nobody remembered to fix.

  The dates are rows. They could have been computed from the recurrence every
  time a calendar was read, the way a bookable resource's slots are, but a slot is
  offered and claimed in the same breath while a date is signed up to - and a
  sign-up is a row pointing at the date it is for, so the date needs an identity.
  It is also what lets one cleaning day be rained off without rewriting the
  recurrence or touching the rest of the year.

  Every time is a wall-clock fact. An event states a first date, a time of day and
  how long it runs, and each date's instants are worked out from those on the
  association's own clock. So a cleaning day at ten in the morning is at ten in
  the morning on every date it falls on, including the two Sundays a year that are
  23 and 25 hours long, and the instants either side of a change differ by an hour
  from what adding seven days to the one before would have given. An event stated
  as nine to three is nine to three on the 23-hour Sunday too, and five real hours
  long that day, because that is what the notice says. The one local time that has
  no answer is the hour the clocks jump over in March: a first date there is
  refused while the board is still on the form, and a later date there is left out
  rather than moved an hour from where it was asked for.

  A rule repeats weekly on the same weekday, monthly on the same day of the month,
  or annually on the same date, every so many of them. A monthly rule on the 31st
  falls on the last day of a shorter month and returns to the 31st afterwards
  rather than spending the rest of the year four days early, and an annual one on
  the 29th of February falls on the 28th in a common year - each date is worked
  out from the first one rather than from the date before it, which is what makes
  that true.

  Every rule states its end, and states exactly one: a number of times or a last
  date. Neither is optional, because the dates are written out when the event is
  saved and nothing extends them afterwards - a rule with no end would not be an
  endless series but one that stopped two years out for a reason no screen could
  explain. Two years is the reach: a rule going further is refused rather than
  truncated, so nothing is written out that the board did not ask for and nothing
  the board asked for is silently dropped.

  Editing an event does not move what people are standing on. An edit is planned
  before anything is written: date by date, which rows stay, which move, which go
  and which arrive. A date is matched by its place on the calendar rather than by
  its instant, so moving an event from nine to ten keeps the row for the 18th of
  April - and with it the sign-ups pointing at it and the board's decision to call
  that one off. A row that would move or go while somebody has signed up to it
  refuses the whole edit, naming the dates, on the same reading the resource
  catalogue takes of a booking somebody holds: whether those dates should change
  is a decision the board takes date by date, not the silent effect of saving a
  form. Dates that have already started are never touched at all, so an event
  whose time the board moved in June keeps its spring dates at the old time.

  An event is entered as a draft and published as a separate act, and it is for
  the members unless the board says otherwise - a cleaning day is arranged for the
  people who live in the house, and putting one on the street is a deliberate
  second answer rather than the default a slip lands on. Publication runs the same
  scan for Swedish personal identity numbers that a page and a news item run, and
  so does every edit to something already published, because an edit to what
  people can read is itself a publication. The refusal names the field and where
  in it the number sits, and never the number.

  One capability carries the module and it is the board's: arranging what the
  association does and announcing it are one job. The property manager is granted
  none of it - they handle the association's issues, they do not arrange its
  cleaning days. Entering an event, editing it, publishing it and calling off one
  of its dates are each in the audit log, carrying the shape of the event, the
  audience, the field names that moved and how many dates were added, moved and
  dropped - and never what the event is called.

- a8825d1: The board can record what each apartment pays the association, and produce the
  period's notices from it.

  A fee is what an apartment pays per month: the annual fee, and a parking or
  storage space beside it. The board records the amount and the day it starts
  applying, and recording the next one closes the one before it, so what an
  apartment pays on any given day has exactly one answer. A fee may be dated
  forward, because fixing the fees is the board's own standing task; a charge may
  not, because it says something has already happened.

  The amount is the board's to state and never the platform's to work out. The
  apartment register now records each apartment's participation share and initial
  share capital, which nothing could write before, and the fee screen offers the
  share as an aid: state the year's total, see what each apartment's share would
  give per month, accept or overwrite each figure. Nothing is worked out when the
  screen is read, and no total is stored anywhere. The law is the reason: the basis
  for calculating the annual fee is a matter for each association's own bylaws, and
  a platform that apportioned by the participation share on its own would be
  enforcing one association's bylaws on every other.

  Issuing a period writes one notice per apartment, each with its own payment
  reference, and a period can be issued once. The board takes the document away as
  a file or as a printed page. Open BRF produces the notices and does not send
  them, and it holds the basis rather than the ledger: it never records a payment,
  never carries an outstanding balance, and works nothing out from the due date. A
  holder with protected personal data is withheld from the document while their
  apartment stays on it, because the apartment is what a fee is fixed on.

  The association now records which month its financial year begins in, and where
  it is paid. That month decides when charges and fees are erased: accounting
  records are kept through the seventh year after the calendar year the financial
  year ended in, which for an association whose year is not the calendar year is a
  full year later than before for part of every year. The window used to count from
  the row's own year. Correcting it only ever moves an erasure date later, never
  earlier, so no date already stated to somebody is brought forward, and for an
  association running the calendar year nothing changes at all. Each charge, fee
  and notice run keeps the month in force when it was recorded, so changing the
  setting later reaches only what is recorded afterwards.

  Amounts are shown grouped and to the ore for the first time, in the reader's own
  language.

- 82a71e5: Erase service data when its retention window runs out, keep it where the law
  says to, and answer a person who asks what the association holds about them.

  The retention policy has shown a purge date on every ended residency since the
  register was built, and until now nothing acted on it. A job runs each night
  and does: for somebody whose last residency ended longer ago than the policy
  allows, it clears the email address and phone number with the blind indexes
  that made them searchable, resets the stated language, deletes the sign-in
  account with its sessions and credentials, and deletes any invitation that was
  never accepted. The name and the postal address stay, because the member
  register is public on request and one that lost its members' names would not be
  a register. The personal identity number stays too: it is confidential
  apartment register content rather than service data, which is why it is masked
  from every screen and reachable only through the audited reveal.

  The member register, the transfers, the lien notes and the audit log are not
  merely excluded from the erasure - nothing can erase them. The database
  refuses to update or delete a row in any of them, and the job is built on that
  rather than on remembering to leave them alone. Each person is erased in a
  transaction of their own, so a run interrupted half way through leaves what it
  finished finished and finds the rest the following night; a person already
  erased is not selected again, so nobody collects an entry a night for ever in a
  log that cannot be tidied. Somebody still sitting on the board, still holding
  an administrator or property manager grant, or still living in another
  apartment is left alone, because none of those relationships has ended.

  A legal hold is the one thing that suspends the purge, and the board places one
  against a named person with a reason it has to write down. It is for data the
  association still needs in order to establish or defend a legal claim, or that
  the law obliges it to keep: a dispute, an insurance matter, a request from an
  authority. Releasing it erases
  nothing by itself - it makes the person erasable again and the job runs in its
  own time - and the released hold keeps the dates it stood between, because that
  record is the explanation for why nothing was purged in that period. The person
  view says in words that a hold stands, beside the purge date it has stopped
  applying to, and the retention setting says that the erasure now happens by
  itself.

  The data subject access report is everything the association holds about one
  person on one printable document: the register entry with the contact details
  and the personal identity number decrypted, the residencies with the date each
  one is erased on, positions of trust, system roles, the account, the statutory
  member register entries and transfers, the lien notes that stood against an
  apartment while they held it, publication consents, legal holds, issues
  reported, documents filed, and the audit log both about them and of what they
  did. A lien note names an apartment and a creditor and never a person, so
  which of them are theirs is read from the member register: a pledge redeemed
  as the sale to them completed belongs on the seller's report, not on theirs,
  and where the archive cannot say whose a note was it is left out - an omission
  the association can correct, where the other mistake discloses somebody else's
  finances. It is produced by the board from the person's own view, gated on
  the capability that governs every other deliberate disclosure of masked data,
  and written to the audit log as an export in the same transaction that reads
  it. There is no public path to it and no way to send it: it is printed and
  handed over. Issues and archived documents are listed on it but are not yet
  purged - their retention windows are a decision of their own - and the document
  says which half of what it lists is erased and which half the law requires the
  association to keep.

  An audit entry now carries facts rather than prose. The log is append-only and
  outside every purge scope, so free text copied into it outlives the record it
  described: a rejected sign-up request carries a purge date and the entry about
  it does not. Entries name the record and let the text be read from there, which
  is why the rejection reason is on the request rather than in the log a second
  time. What an entry may still carry is a reason somebody typed for the log
  itself - why a protected person's data was revealed - because that has no other
  home and is what lets the record answer why, and not only who and when.

- 09556db: Stop a temporary table from standing in for a table a statutory guard reads,
  and take temporary tables away from the application's database role.

  The triggers that check a transfer reversal and a reporting obligation against
  their transfer read `transfer` by an unqualified name. A trigger function runs
  as whoever writes the table and resolves such a name through that session's
  `search_path`, where the session's temporary schema comes first. The
  application's role could create temporary tables, so it could create a
  `transfer` of its own and record a reversal of a grant, or a reporting
  obligation the association does not have, on tables that cannot be corrected
  afterwards.

  - A migration sets `search_path = pg_catalog, pg_temp` on every `openbrf_`
    function and names each table and type the two guards read with its schema.
    The triggers themselves are unchanged.
  - `harden-runtime-role.sql` revokes `TEMPORARY` on the database from the
    runtime role and from `PUBLIC`, and stops if a grant made by another role
    survives the revoke.

  **Upgrade note:** a deployment that runs the bundled steps needs nothing. One
  that manages its runtime role by hand runs, as the database's owner,
  `REVOKE TEMPORARY ON DATABASE <database> FROM <runtime role>, PUBLIC`. A
  monitoring or backup role that creates temporary tables is then granted
  `TEMPORARY` by the owner.

- edc9eb1: Record what a person has agreed may be published, and widen the audit log to
  cover the acts that decide access.

  Publication consent (publiceringssamtycke) is now a record the board keeps, on
  the person view beside the protected personal data flag. It covers one scope at
  a time - a photograph, a name on the website, the published board roster -
  because agreeing to be named is not agreeing to be photographed. Granting and
  withdrawing are dated facts rather than a switch: a withdrawal closes the
  consent with a date and leaves the row on file, so the period a consent covered
  stays readable, and that period is what says a page published while it stood was
  published lawfully. A person who agrees again is recorded again, beside the
  earlier consent rather than over it. Every change writes an audit entry in the
  same transaction, and a change that changes nothing writes neither an entry nor
  a date. The field is the board's, on the board's own person view: the
  resident-facing directory has no person view at all.

  The audit log gains the vocabulary for the acts that decide who reaches the
  association's data. An invitation now records both halves - the board issuing
  the link and the recipient using it - and a self-signup decision records the
  approval or the rejection, each in the same transaction as the decision itself,
  so a board member who loses the race to decide a request writes nothing. A theme
  written on the instance is recorded as composed as well as installed, which is
  the difference between tokens authored here and a package downloaded from a
  catalog.

  The personal identity number's parse, canonical form and checksum move into the
  shared package, unchanged byte for byte, and gain a scanner that finds one in
  free text. The scanner is what lets a personnummer be refused at the keyboard
  rather than after a page is live: candidates are matched by shape and then put
  through the same validator a stored value goes through, so the calendar and the
  checksum are what decide. An organisation number is left alone - a housing
  cooperative prints its own in its footer, and the third digit pair of one is
  never a month.

- ca89fbc: Serve an internal file only to holders of the capability it names.

  Every file held INTERNAL now names a capability, which a database CHECK
  enforces and the upload refuses to skip: attachments collected by the board
  mailbox are read with `boardMailbox:handle`, and the photos on an issue report
  with `issues:handle`, while the resident who reported the issue still sees its
  photos. A migration gives files already stored the capability of what they
  belong to, and each read by capability is written to the audit log.

  `media_file.visibility` has no default any more: every write states it.

- 6ef5a70: Add the invitation flow to the interface: inviting from the person view, and
  activating from the link in the email.

  The person view now carries the action that follows from the account state it
  already showed. A person the register holds an address for is invited with one
  button. A person with an invitation outstanding shows the date the link stops
  working and is offered a new one - a lost email is the ordinary reason an
  invitation goes unanswered, and sending a new one supersedes the old link rather
  than leaving two of them alive. A person the register has no address for is told
  that, instead of being offered a button that could only fail, and an instance
  whose email settings were never filled in is told which settings are missing
  rather than that the invitation was refused.

  The link in the invitation email opens a screen. It asks for a password and
  nothing else: everything else about the person is already in the register, and
  the token in the link is what says which person this is. A successful activation
  leaves them signed in on the register, with no second trip through a sign-in
  form. That session comes from an ordinary password sign-in rather than from the
  activation endpoint minting one, so the rate limiting, the cookie settings and
  the second-factor policy apply exactly as they do to every other sign-in. What
  makes it possible is that a successful activation answers with the address the
  account was created for - disclosed only to a caller holding a valid, unused
  token that was mailed to that very address. Every refusal still answers with a
  reason and nothing else.

  Each refusal is a sentence of its own, in the recipient's language. A link that
  has already been used and an address that already has an account both say the
  account exists and point at the sign-in screen; an expired invitation says to
  ask the board for a new one; a link carrying no usable token says so before
  asking for a password. An activation that succeeded but could not sign the
  person in says the account is ready and sends them to sign in, because the
  account exists either way and a second attempt would only meet a link that has
  now been used.

  The end-to-end suite drives all of it through a browser: the board invites two
  people from the register, and each of them sets a password on the activation
  screen and lands on the address book without visiting the sign-in form.

- 2a8ba9b: Add the issues module: reporting with photographs, the triage queue, and issue
  types scoped to an audience.

  The categories are the board's own vocabulary for its building, configured in
  settings, and each one is offered to exactly one audience: non-member, member,
  or board. Which of them a person is shown is decided on the server for every
  caller - a resident picks from the member types, a caller with no session from
  the non-member ones, and the board's internal categories are shown to nobody who
  does not handle issues. Posting the identifier of a type that was never offered
  is answered as if that type did not exist, so the catalogue cannot be
  enumerated one guess at a time. A type that reports have been filed under is
  deactivated rather than deleted, because those reports say what they were about
  only through it.

  A resident reports from the application against their own apartment or against
  free text, attaches photographs, and follows the report through new, in progress
  and done. Photographs go through the media layer like every other file:
  identified from their own bytes, given a generated key, and served from the
  association's own origin. They are internal and are attached by signed-in
  reporters only.

  The description is free text and is deliberately neither scanned nor refused.
  An issue report is exactly where health data and a third party's details arrive
  without anybody intending it, so the form carries a standing sentence saying
  that everyone who handles issues - an external property manager included - reads
  what is written. A reporter with protected personal data is named to nobody in
  the queue, and a reporter the register no longer holds is reported as unknown
  rather than invented.

  Whether the association's website carries a form anyone can use is a setting,
  on by default: an issue report produces a maintenance ticket rather than an
  account on an instance holding a statutory register. With it off, the anonymous
  audience is refused at the service, so the form stops existing rather than
  being hidden.

  Three capabilities carry the module. `issues:report` goes to residents and to
  the board, `issues:configure` to the board, and `issues:handle` - which existed
  unused - now also reaches the board beside the property manager. The navigation
  follows: an external property manager is offered the issue queue and their own
  settings, and the address book is no longer among their destinations at all.

- 04739fb: Let whoever runs an instance set its mail in the environment, either an SMTP
  server or an HTTP mail API that takes a message as JSON with a key. Mail set
  that way is used for every message the instance sends, from an address that
  need not be on the association's own domain, under the association's name, and
  with replies directed to the association; the settings screen and the setup
  wizard show which service sends it and from which address, and no longer offer
  to change it. Answers from the board mailbox keep their threads when the mail
  service assigns its own message identifiers. Settings a board entered earlier
  are kept and apply again if the environment stops setting the mail. The record
  of processing activities and the processor register name the service mail
  actually goes through.

  An SMTP relay set in the environment must offer STARTTLS before the instance
  signs in to it, unless it is on the same machine, and every subject goes out on
  one line, including an answer quoting a subject an outside sender wrote.

- f9befbb: A member can now let an app they chose act for them, and take it back.

  A connected app is an external program - a chat client, an assistant, something
  the association had written - that a member points at their own instance and
  signs in to as themselves. It holds a token rather than the member's password,
  and it can never do more than that member can do, within the coarse scope its
  token carries: the token is looked up on every call and the member's own
  permissions are read again from the register each time. A read-only connection
  stays read-only however much the member themselves may do. Nothing is
  remembered from when they connected it. A board term
  ending therefore narrows every app that person connected on the same night it
  narrows the person.

  Connecting is the member's own decision and needs no permission from anybody.
  Cutting a connection takes effect on the app's next call, not when its token
  would have run out: the board sees every connection on the instance and can cut
  any of them, and a member sees and cuts their own. Every connection made or cut
  by somebody else is in the audit log, against the member, naming the app.

  An app is told nothing about who it is acting for. It receives no name and no
  address, only the ability to ask the platform to do things the member could
  already do.

  The address an app actually talks to belongs to a connector plugin, not to the
  platform, so an instance needs one installed before anything can connect. Only
  one plugin may serve it, and a second is refused when it is installed rather
  than after: that address is what every token already granted is bound to, and
  moving it would break every connection the members have.

  Two settings matter to whoever runs the instance. `APP_URL` must now be an
  https address or a loopback one, and the instance says so and stops rather than
  failing later in a way that is hard to read. Changing it afterwards disconnects
  every connected app, because a token issued for one address is not accepted at
  another - members reconnect, and nothing is lost.

- c00a615: Add file uploads and media storage, and the housing cooperative's logo on top
  of it.

  One storage interface with two drivers, both shipped and both covered by tests:
  the local disk under `OPENBRF_DATA_DIR`, and any S3-compatible bucket. Which
  one an instance uses is configuration and changes nothing above the driver.

  Files are always served from the association's own origin. The API streams the
  bytes; it never answers with a link or a redirect to the storage endpoint,
  because either would hand the storage provider the IP address, the timing and
  the referring page of every visitor - the same disclosure the platform refuses
  to make for typefaces. The S3 path is tested for exactly that, against an
  S3-compatible server running in the test process.

  An upload is identified from its own bytes rather than from the content type or
  the file name the request declared, and its storage key is generated rather than
  taken from either. Size is enforced while the body is read, and
  `OPENBRF_MAX_UPLOAD_BYTES` may not be configured above 32 MiB: an upload is held
  in memory in full while it is identified, checksummed and stored, so a larger
  value is refused at boot rather than left to exhaust the process. An image
  upload declares whether it shows identifiable persons; the declaration is
  recorded so the publication guardrails can use it, and the consent engine itself
  comes with the public website.

  Serving is authorized per file: public files reach anyone, which is what a mail
  client rendering the association's logo needs, and a file may be narrowed to
  holders of one capability, in which case each serve is written to the audit log.
  A file that may not be read is answered exactly as one that does not exist.
  Deleting a file writes its audit entry in the same transaction that removes the
  row, so the append-only record cannot be missing an entry for a deletion that
  happened.

  The logo is uploaded in settings under appearance and in the setup wizard's
  appearance step. There are two slots because the application's top band is dark
  and a mark drawn in dark ink disappears on it: a variant for dark surfaces is
  optional, and without one the band puts the mark on a light plate, which the
  settings screen previews rather than leaving the board to discover.

- cbda3fe: Add the notice (kallelse) that summons a general meeting, on a delivery ledger
  of its own, and the link from a motion to the meeting that takes it up.

  EFL 6 kap. 22 § is what makes a notice a notice rather than a message about a
  meeting. It requires the time and the place; where the meeting is to be held
  digitally, how the members are to take part and to vote; and the matters to be
  dealt with, clearly stated. The first two are columns on the notice. The day is
  not: it stays on the meeting, because it is the day that decides who has a vote,
  so the notice carries the hour and is written only where that hour falls on the
  meeting's own day. The participation instruction is one nullable column rather
  than a flag beside a text, because that paragraph makes the instruction required
  exactly when the meeting is digital - so the instruction being there and the
  meeting being digital are one fact and not two that could disagree.

  The matters are the meeting's agenda, and they are not copied onto the notice.
  Issuing it freezes them instead. **That freeze is the load-bearing part of this
  change.** EFL 6 kap. 15 § gives a member the right to have an item taken up _in
  the notice_, and 6 kap. 25 § leaves the meeting unable to decide a matter the
  notice did not take up without the consent of every member the failure affects.
  So which items a meeting may deal with is settled by its notice: from the moment
  one is issued the agenda cannot be rewritten, and no motion can be put to that
  meeting or taken off it. Three refusals follow from the same paragraph. A
  meeting with no agenda cannot be summoned, because a notice stating no matters
  is not a notice. A meeting recorded as held cannot be summoned. And a meeting
  already summoned is not summoned twice - the remedy 6 kap. 25 § gives for a
  notice that went wrong is that the meeting may resolve to convene an extra
  general meeting, which is a meeting of its own with a notice of its own, rather
  than that a second notice repairs the first.

  The fourth limb of 22 § has no column. Where an item concerns a change to the
  bylaws the notice must state the main content of the proposal, and nothing here
  records that an item is a bylaws change or holds the proposal, so the board
  writes that content into the item as the notice states it.

  **The ledger is the news delivery ledger's shape on a table of its own**, because
  a notice is not a news item. One row per recipient, snapshotted inside the
  transaction that issues the notice, with the triple of notice, person and channel
  unique, and the worker claims each row conditionally from PENDING before it hands
  anything to a mail server - so a retried job summons nobody twice. The channel
  is an enum with one value and a default, which is the news ledger's own history
  read forwards: its channel column carries a default so that rows written before
  there was a second channel keep their meaning, and a column that starts with one
  makes a second channel an added value rather than a backfill of rows nobody can
  ask again. Post is deliberately not a value: EFL 6 kap. 21 § andra stycket
  requires a letter in three cases, and this platform posts nothing and records
  none of the facts those cases turn on.

  A failure is recorded as a code and never in the mail server's own words, because
  a rejection quotes the envelope back and the envelope is a member's address. It is
  recorded on the row and never rolled back onto the notice: the meeting has been
  summoned, and one address that did not work is a fact for the board to act on.

  **A member the association holds no address for is written into the ledger and
  failed, rather than left out of it.** That is deliberately the opposite of what
  the news mailing does with a member it holds no telephone number for, and the
  difference is what the two ledgers are for. A news mailing is an announcement,
  and somebody it could not reach has missed something that is on the association's
  website anyway. A notice is a summons the association owes each member (EFL 6
  kap. 21 §), so a member this platform cannot reach is precisely what the board
  has to be shown - because calling them is then the board's own job. The failure
  carries a code of its own, so a member with no address is distinguishable from
  one who has left the register.

  Electronic notices are lawful for a housing cooperative: **BRL 1 kap. 10 §
  applies the rules on information by electronic means in EFL 1 kap. 16 § to a
  bostadsrättsförening sending kallelser.** That paragraph's first stycke attaches
  three conditions - the general meeting has resolved on it, the association has
  reliable routines for identifying the recipient together with reliable
  information on how to reach them, and the recipient has consented. The second
  stycke presumes the consent of a recipient who has not objected within a time
  stated in a request sent by post, which must be at least two weeks from the day
  the request was sent and must state that future information may be given by the
  named electronic means unless they expressly object; the third lets a consent be
  withdrawn at any time. Only the first of the three is association-wide: the
  second is a routine rather than a record, and the third is per-recipient and
  revocable. None of the three is a fact this platform decides, and none is
  claimed: the ledger records that the association sent the notice, never that it
  was entitled to, which is the same line the proxy authorisation draws between
  the board seeing a signed document and the platform producing one. The time
  within
  which a notice is to be issued (EFL 6 kap. 17-18 §§) is stated and never
  enforced, because both sections let the bylaws move the latest date and this
  platform holds no such clause.

  The message carries the notice in full - the kind of meeting, the time, the
  place, the participation instruction where there is one, and every matter in its
  running order - and offers no link and no button. That is the opposite of the
  news mail, which carries a title and a link because the article lives on the
  association's website. A notice has no such home: 22 § makes the content the
  requirement, and a link to a page behind a sign-in is not a notice that has been
  given.

  **`Motion.meetingId` is the linkage the first tranche deliberately left out**,
  nullable, and it lands here rather than with the meeting because the notice is
  what decides which meeting takes an item up. It is refused once that meeting's
  notice has been issued and once the meeting has been recorded as held, and the
  refusal is checked against the meeting being left as well as the one being
  joined: detaching an item a notice stated is the same failure as attaching one it
  did not. A motion the member took back is refused on different ground - the right
  in EFL 6 kap. 15 § is theirs to exercise and taking it back is theirs too. The
  link is its own act with its own audit action, and the member who submitted the
  motion stays the subject of the entry, so what the board did with their item is
  answerable from their own data subject access report. Both views name the meeting
  and its day rather than giving an identifier, because a member holds no
  capability that would let them resolve one.

  The write is conditional on the link and on the state the caller read, and each
  condition carries its own answer. A request that loses the race for the link is
  told the item moved rather than that the motion is closed - it is exactly as
  open as it was, and what the board has to do is read the queue again. A request
  that loses it to the member's own withdrawal is told that, because the
  withdrawal is a transaction of its own that takes no agenda key and can commit
  between the check and the write: without the condition the board would be
  recording that it will take up a request the member had taken back. The refusal
  is deliberately one-sided - a member withdrawing an item already put to a
  meeting is exercising their own right, and that state is recorded honestly.

  **The freeze is held by an advisory lock on the meeting**
  (`meetings/agenda-lock.ts`, keyed `meeting-agenda:<meetingId>`). Three writers
  read whether a notice exists and then write on the answer - issuing the notice,
  replacing the agenda, and linking a motion to a meeting or taking that link
  back - and at READ COMMITTED being inside a transaction is not the guarantee: a
  notice committing after the read and before the write is invisible to the
  reader, and the write lands. The three touch different tables, so nothing in
  the database refuses either outcome and both are silent. It is a second key
  rather than the proxy lock's, because who may exercise a member's vote has no
  bearing on which matters were summoned and one key for both would queue
  unrelated board work. A move holds the keys of both meetings, sorted, so two
  moves in opposite directions between one pair cannot deadlock. The unique key on
  `MeetingNotice.meetingId` stays the last line of defence and its refusal is now
  worded rather than escaping as a client error.

  Neither ledger table appears in the data subject access report, on the news
  delivery ledger's own precedent: what the report answers for is the meeting's
  record - who was present, and the authority a vote was exercised under - and a
  mailing ledger is the association's record of an act it performed.

  Migrations `20260909100000_meeting_notice` and
  `20260909110000_meeting_notice_audit_actions`.

- a59d97a: Add the general meeting: the meeting itself, its agenda, who was present and in
  what capacity, the proxy authorisations under which somebody else exercises a
  member's vote, and each item's outcome recorded beside the vote counts it was
  declared on.

  EFL 6 kap., which BRL 9 kap. 14 § applies to a housing cooperative with six
  exceptions. Four of those six are the association's own bylaws clauses and the
  other two are prohibitions, so both halves are settled here rather than left for
  the screens: postal voting does not apply to a housing cooperative and the
  meeting's powers may not be delegated to fullmaktige, and neither is built.

  **The voting register is derived and never stored.** No vote count and no
  eligibility flag exists on any row, exactly as a booking allowance is counted
  out of the residencies at write time and for the same reason - a stored figure
  goes stale the moment somebody moves or a transfer completes, and it goes stale
  silently, because nothing about the row looks wrong. Every member has one vote
  (EFL 6 kap. 3 §), so a member holding two apartments has one and not two: the
  vote belongs to the membership and not to the holding, which the plan for this
  module had backwards at first. Members holding one bostadsratt jointly have one
  vote between them (BRL 9 kap. 14 § 1, and unconditional, unlike the storage
  limitation in the same paragraph), so their memberships are one line - and a
  member who shares one apartment with a second and another with a third is one
  line with all three, because a member cannot have one vote with each of them
  without having two. The line names every member and every apartment that went
  into it, which is what lets a meeting change the register: EFL 6 kap. 27 § has
  it drawn up by the chair, approved by the meeting, and standing until the
  meeting resolves to change it.

  Two sources, each for what it is the record of. Whether somebody was a member on
  the meeting day comes from the member register (medlemsforteckning), which
  bostadsrattslagen requires, which is append-only, and which can therefore still
  answer for a meeting held years ago. Which bostadsratt a membership covers comes
  from the residencies with the MEMBER role, the rows the apartment register
  itself reads to list an apartment's holders - the archive cannot answer it,
  because an EXIT row is written only when a person's last tenant-ownership ends,
  so it leaves an open entry on an apartment somebody sold while keeping another,
  and a merge keyed on that would put a seller and their buyer on one line with
  one vote between them.

  An assistant is on the register and carries no vote. EFL 6 kap. 7 § lets a
  member or a proxy holder bring at most one, who may speak at the meeting, and
  that is the whole of what it grants; EFL 6 kap. 27 § still lists them among
  those present, so they are a line without a vote rather than an absence. The
  database states the one-each rule as a constraint. A person can be on one
  meeting's register twice - as a member and as a proxy holder, which is the
  ordinary case for somebody arriving with a neighbour's proxy authorisation - so
  the capacity belongs to the line and not to the person, and that person has two
  votes and one body.

  **A proxy authorisation is checked against the statute and the bylaws, and is
  never signed here.** EFL 6 kap. 4 § holds an authority good for at most one year
  from the day the member signed it, and that is asked again when the register is
  drawn rather than trusted from the registration: the meeting day can be moved
  afterwards. A member may not be represented by more than one proxy holder, which
  is checked behind an advisory lock keyed on the meeting and the member: the rule
  is over the authorisations standing at any moment, so no index can state it, and
  a plain read before the write would let two board members naming different
  holders each find none. Who may be a proxy holder is the member's spouse or
  cohabitant or another member unless the bylaws say otherwise (BRL 9 kap. 14 §
  4), and the ground the board relied on is recorded because only one of those
  limbs is decidable: the register says who is a member, and nothing here records
  who is anybody's spouse or cohabitant - so an authorisation resting on that is
  the board's own statement, and refusing it would refuse what the statute permits
  outright. What the row records is that the board saw the paper. It records no
  signature and implies none: a document that has to be signed under that Act may
  be signed with an advanced electronic signature (EFL 1 kap. 15 §), which is a
  trust service the free core does not provide.

  All four bylaws clauses sit with the instance settings, each defaulted to the
  statutory position rather than to a blank - unlike the motion deadline, which
  has no default because the statute supplies no rule where the bylaws are silent.
  One member per proxy holder, and deliberately not the three EFL 6 kap. 5 §
  allows an economic association generally: BRL 9 kap. 14 § 4 replaces that rule
  for a housing cooperative, and an instance defaulted to three would let one
  person arrive holding a block of votes the statute keeps out of a
  bostadsrattsforening. Two of the four are checked when a proxy is registered and
  two are stated for the board to apply in the room, and the line between them is
  not a matter of effort: the platform enforces a clause exactly when it holds the
  facts the clause turns on. It knows who is a member; it holds no record of who
  is anybody's spouse and none of what a space in the building is used for, so the
  storage-only voting limitation and the assistant rule are reported rather than
  applied. An answer invented from a participation share would take somebody's
  vote away on a guess.

  The chair records each item's outcome and the counts, which is how EFL 6 kap. 39
  § has the minutes state an omrostning. The outcome is recorded and not computed
  from the counts, and that is the statute rather than a shortcut: an ordinary
  question carries on more than half the votes cast with a casting vote on a tie,
  an election goes to whoever got the most votes, and a change of the bylaws falls
  under BRL 9 kap. 23 § and 24 § forsta stycket instead - which rule an item falls
  under is a fact about the item that nothing here holds. Abstentions are counted
  and belong to no majority. Corrected in place with the audit log carrying what
  it moved to, because what stands is the signed protokoll: EFL 6 kap. 39-40 §§
  leave that document with the association, filed in its archive, which is what
  the motion module already says of a meeting's lasting record.

  A vote record arrives with no voter recorded and nothing writes into it. A
  closed ballot (sluten omrostning) is a vote with no voter. EFL neither requires
  one nor forbids one - the word does not occur in 2018:672 - so it is the
  meeting's own procedure rather than a right, and adding that column later
  would mean migrating a table the association's minutes are built from. Real-time
  voting is separate work.

  Same change, because this is the change that creates the tables: the data
  subject access report carries a person's attendance at a general meeting and
  every authority naming them. The proxy section answers for both roles - an
  authorisation names the member who authorised somebody to exercise their vote
  and the proxy holder authorised to exercise it, which are two different facts
  about two different people - on the
  pattern the audit log's own two person columns already set. Neither section
  states an erasure date, and that is an answer rather than an omission: the
  register is taken into or appended to the minutes and the minutes are kept, so
  these two sit with the statutory register sections, kept because the law
  requires the record and printed because exemption from erasure has never been
  exemption from access. The other person on an authorisation or beside an
  assistant is an identifier and never a name, which is what art. 15(4) forces on
  a document the association hands over.

  The board's screens, the notice, the link from a motion to the meeting it is
  taken up at and the end-to-end suite follow separately.

- 2660f5c: Record charges to members (debiteringar mot medlem) and export the debiting
  list: a one-off cost the board puts on a named member or on an apartment - a key
  to the bike room, a replacement tag, a subletting fee, a repair charged on - with
  the amount, the date, the reason, the VAT treatment and the day the basis went to
  the economic manager. The board records one on a screen of its own, reads the
  list for a period, and takes it away as a CSV file and as the printed page a
  browser writes a PDF from.

  Open BRF holds the basis for the charge and not the ledger. There is no paid
  column, no status that stands in for one and no balance, and the absence is the
  module rather than an omission: the accounting system is where a debt is settled,
  and a second answer to whether something has been paid is worse than none. The
  nearest thing to a workflow field is the day the basis went to the manager, which
  is a fact about the row and says nothing about what happened to it afterwards.
  Nothing here is shaped to receive the paid half either, with no export target, no
  schedule and no hook, because a seam left for a thing that does not exist is a
  guess about its shape.

  A charge names a person or an apartment and never both, which the table enforces
  along with a positive amount, a rate that belongs to the treatment carrying one
  and a reason with something in it. Recording both would give two answers to who
  is being charged the day the apartment changes hands. An apartment-keyed charge
  is still personal data, because the flat leads back to whoever lives in it, so
  both kinds sit in the service tier under the same access control, masking and
  audit log as everything else.

  The whole module is behind `memberCharges:manage`, which the board holds and the
  external property manager does not: what the association charges its members is
  its business with its own members. There is no resident half, since a member
  learns what they are charged from the notice the accounting system sends, so a
  resident who types the address reaches a screen that says whose it is and offers
  no control the server would refuse.

  A member with protected personal data is named on the list and their apartment is
  withheld from it, on the member register extract's own rule and for its own
  reason: the list is handed to a bookkeeper outside the association, and the link
  from a name to a door is what protection exists to withhold. The name stays,
  because a bookkeeper who cannot be told who to invoice has been handed a list
  they cannot use. The rule holds on the screen and in the file, and the file says
  "protected" beside the empty cell so the emptiness reads as deliberate rather
  than as a gap.

  The reason is board-written free text and is scanned for a personal identity
  number when it is written and on every later edit, with the refusal naming the
  field it was found in and never the value. It is copied into a file that leaves
  the association, which is why the scan reaches the edit as well as the first
  write.

  Where the register holds two people of one name in one flat - a father and a
  son - the picker names the day each of them moved in, because an option that
  read the same for both would ask a board to choose between two identical rows,
  and charging the wrong one puts a sum on a member it was not for. The date is
  added only to the rows that need it.

  Every charge is on its subject's data subject access report, by its own column or
  through the apartment they were living in on the day it is dated, and each row
  states the earliest date the purge can reach it. A nightly purge erases a charge
  at the end of the seventh calendar year after the one it falls in, which is how
  long the accounting record it was the basis for is preserved
  (bokföringslagen 7 kap. 2 §), unless a legal hold stands against the
  person charged or, for a charge on an apartment, against anybody who has ever
  lived there.

- 29d4db1: Add motions to the general meeting: the table, the two capabilities, the
  member's intake and the board's queue, with the retention story a person-linked
  table has to arrive with.

  The right belongs to a member and not to a resident. EFL 6 kap. 15 § gives a
  member the right to have an item treated at a general meeting if they ask the
  board in writing in time for the item to be taken up in the notice, and
  BRL 9 kap. 14 § applies that chapter to a housing cooperative with six
  exceptions of which this is not one. So `motions:submit` is the first capability
  this platform derives from membership rather than from residency, a board seat or
  an administrator grant: a partner, an adult child or a tenant living in the house
  is offered nothing, and neither is a board member who holds no tenant-ownership,
  because the right attaches to the membership and not to the office. The register
  is asked again before a motion is written, which is what settles the
  administrator case - a grant on an instance holds every capability the model
  defines and is not a share in the association. The same paragraph withholds the
  right from a member who has been excluded even though the membership has not yet
  ended; this platform records no exclusion, so that case is not subtracted, and
  the check says so where it is made rather than pretending otherwise.

  The deadline is the association's own. The same paragraph leaves the manner and
  the time to the bylaws, so it is recorded on the instance settings as a recurring
  month and day - a standing clause rather than one year's date - with no default
  at all: an association whose bylaws are silent has no date for the setting to
  hold, intake stays open and the board decides what it can still take up. The
  paragraph's own condition, that the request reach the board in time for the item
  to go into the notice, stands whatever the bylaws say - but it needs a notice
  date, and no meeting exists here to give it one. Nothing refuses a late motion
  either way, because that condition decides which meeting an item can reach rather
  than whether the association may receive it. The board reads the clause with the settings it
  answers for, and an administrator changes it.

  A motion carries a title, the proposal, and the member who submitted it as a
  plain reference the purge can erase around. It is received rather than approved:
  the board records that it has the item, whether the meeting adopts the proposal
  is minuted at the meeting, and there is no route that rejects one. A motion
  closes with a date and a status - acknowledged, or withdrawn by the member while
  it was still open - and closing it is not deleting it: no route removes a motion,
  because the record that a member put something to the meeting is theirs while the
  association holds it at all. What ends it is retention, two years after it
  closed, described in the last paragraph below. It deliberately carries no meeting
  reference: linking a motion to the meeting it is taken up at arrives with the
  meetings module.

  The title and the proposal are scanned for a personal identity number and refused
  if they carry one, with the field named and the value never echoed. Unlike an
  issue description, which is neither scanned nor refused, a motion is circulated -
  into the notice, read out in the room, into the minutes - so it travels the same
  publication guardrail a page and a news item do.

  Same change, because this is the change that creates the table: the data subject
  access report carries a person's motions in their own words with the date each
  becomes erasable, a nightly purge erases a motion two years after it closed, and
  a legal hold stops it for the person it stands against - re-checked inside the
  deleting transaction under the advisory lock, so a hold placed while a run is in
  flight wins. An open motion is never purged: the association is still processing
  it, so the purpose it is held for has not ended.

  The screens, the navigation entry and the end-to-end suite follow separately.

  The deadline pair is refused by the database as well as by the API, with the
  day bounded by the month it names - a flat one-to-thirty-one would have
  admitted the 31st of February, which the API refuses.

- dc62953: Add comments on news items: the residents' side of a notice, and what becomes
  of what they wrote.

  A comment is one resident's reply under one news item, written and read inside
  the application. Residents and the board hold `news:comment`; the external
  property manager does not, on the same footing as reporting an issue - they
  handle the association's issues and do not live in the building. The
  conversation is flat: one list of comments under one notice, and no threads
  within threads, no reactions and no mentions. A full discussion forum is
  deliberately never built, because a cooperative that wants one is better served
  by software built for it than by a second-rate copy inside this one.

  Visibility is inherited rather than decided again. A comment is exactly as
  visible as the news item it sits on, so a draft has no thread at all and the
  refusal for a draft is the refusal for an item that was never written - a
  resident cannot walk the identifiers to learn what the board is working on. No
  comment is rendered on the public website, and a comment on a public notice is
  still not public: those pages take no authenticated writes and read no session
  at all, so a thread there would be either anonymous or a login wall on a page
  that promises neither. The reads and the writes are application endpoints, and
  the module graph is what holds it - nothing under the website's own directory
  can reach the service.

  The board can strike a comment through and cannot erase one. Hiding writes the
  date and the person who decided it, and nothing clears either: the comment stays
  in the thread for every reader, its author is still named, and only its text is
  withheld - readable to the board and to whoever wrote it. A board able to make a
  comment disappear would leave nobody reading the thread afterwards able to tell
  which had happened. Moderation is the `site:manage` the board already holds for
  publishing in the cooperative's name, rather than a second capability with an
  identical grant list. Both acts are written to the audit log in the same
  transaction as the change, the hide recorded against the person it was done to.

  A personal identity number refuses the comment, naming the position in the text
  and never the number. This is the first place the guardrail protects a member
  from themselves rather than the association from its board: elsewhere the person
  writing is the person publishing, while here somebody pastes a neighbour's
  details into a reply about a dispute, and the refusal is what stops the whole
  house reading it. A comment is capped in length and each person has a budget of
  comments per ten minutes, counted from what they actually wrote so that it
  survives a restart and is the same budget in every process. No CAPTCHA, here or
  anywhere in this product.

  A comment carries the person who wrote it, so it arrives with its retention.
  Every comment is on the data subject access report with its text in full - a
  moderated one included, because a person is entitled to read the words the board
  took off the thread - beside whether it is hidden and the earliest date the
  purge can reach it. A nightly job erases comments a year after they were
  written, on their own clock rather than the one that governs a former resident:
  a comment's purpose ends with the conversation it belongs to, whether or not
  whoever wrote it still lives here. A legal hold standing against the author
  stops that, and stops it inside the eligibility query as well as inside the
  deleting transaction, so held people can neither be erased nor fill a run with
  work that cannot be done. An author with protected personal data is named to
  nobody, the board included.

  The screen that renders a thread is not in this change.

- d592c19: Keep moderation on a taken-down notice, and read a comment thread a page at a
  time.

  Striking a comment through no longer tests whether the notice above it is
  published. Publication decides who may read a thread and who may write into one;
  it decides nothing about the board's one act over a comment already on one, and
  the text a board most wants struck is often exactly the text it took the notice
  down over. The not-found answer stays where it belongs, on the comment that is
  not there. Reading a thread and writing into it are unchanged, because there the
  caller holds `news:comment` and a draft has to stay invisible; an author's own
  words were already answered without regard to publication by the data subject
  access report, and still are.

  The strike-through is now a conditional update taken before any read, so two
  presses in the same instant are one act with one audit entry rather than two.

  The thread endpoint answers a bounded page from the newest end and the cursor for
  the page before it, and the reading screen carries the control that asks for it.
  The cursor is the instant and the identifier of the comment the page ended at:
  the instant alone is not a total ordering, and a page boundary on a tie either
  repeats comments or loses them. A page size on its own would have been worse than
  the unbounded read, because a comment missing from a discussion reads as a
  moderation nobody performed.

- c019cd2: Add news: what the board writes to the house, and the news mailing that goes
  out at most once.

  A news item is the association's own writing - a headline, an address under
  `/nyheter`, and text in paragraphs with subheadings. It is written as a draft
  that nobody can read, and publishing it is a separate act in which the board
  also says who it is for. Members only unless it says otherwise: a notice about
  the laundry room is written for the people who live in the house, and putting
  one on the street is a second, deliberate answer. A member-only item is served
  to anyone signed in and answered to everybody else with the same not-found
  document, byte for byte, that an address with nothing behind it gets - so a
  visitor with no account cannot learn that the association has written anything
  there at all.

  Publishing offers to email the members, on by default, and no member is ever
  written to twice. The offer is made once and then it is gone: publishing claims
  the news mailing in the same transaction that writes down who it is for, one
  row per member with the pair held unique, and the worker claims each of those
  rows again before it hands a message to a mail server. Editing a published item
  does not touch any of it, so correcting a spelling mistake in a notice cannot
  put that notice in anybody's mailbox a second time - not because anyone
  remembered to check, but because the ordinary save writes three columns and
  none of them is the one that decides. Two board members publishing at the same
  moment produce one mailing between them, and a job retried after a restart
  carries on with the rows it had not yet claimed. Claiming before the send is
  what makes a second copy impossible, and the cost is the other way round: a
  worker lost between the claim and the mail server takes that one recipient's
  copy with it.

  The recipients are the members, with an address to write to. Not every resident
  is a member, and the mailing follows the tenant-ownership rather than the front
  door. Who they are is taken as they stand at the moment of publication and
  never revisited: somebody who moves in next week is not sent last week's news,
  and somebody who moves out between the publication and the send still receives
  it, because that list is the record of who the board was addressing. Each
  person is written to in their own language, and the address is decrypted where
  the message is composed - never carried in a job.

  Reading public news needs no account and no capability. A member-only item is
  readable by anyone signed in, and answered to everyone else with the same
  not-found document an address with nothing behind it gets - so the news follows
  the rule the pages already do. The index and each article are the same plain
  server-rendered documents every other page is: one inline stylesheet, no
  script, nothing fetched from anybody else, and no cookie set - a signed-in
  reader's session travels with the request, and nothing here adds to it or
  refreshes it. A page can carry the latest items as a teaser block, and what
  that shows follows its reader - the public items for a visitor, the members' as
  well for anyone signed in - so the same page reads correctly for both without
  the stored page knowing who either of them is.

  The menu can now point at it. The news index was already one of the generated
  destinations the menu editor offers, held back from the rendered menu while
  nothing served that address; it is served now, so an entry pointing at it is
  shown. The entry is the same for everybody, because which items the index
  lists is the index's own question: a visitor with no account is answered with
  what anybody may read, never with a refusal and never with a count of the
  items they may not.

  The publication guardrails apply here as they do to a page. A personal identity
  number refuses the publication and says which block and which position it is
  in, never the number itself, and a body may hold text and nothing else: a news
  item is an announcement, not a page layout. Publishing one in a public notice
  would put a personnummer in front of anybody who found the address - a
  personuppgiftsincident the association would have to assess and, in the
  ordinary case, report to Integritetsskyddsmyndigheten within 72 hours. That is
  why the guard sits in the write path rather than in whoever is proof-reading.
  Every publication and every news mailing is written to the audit log in the
  same transaction as the change it records. Where an instance has no mail
  server, the item is published all the same and the board's screen says exactly
  that - what failed was the post, not the notice.

- 2d792c6: Add the screen the house reads the association's news on, with the comment
  thread under each notice.

  One destination for whoever lives in the building: the published notices newest
  first, the one that is open with its body, and the thread under it with a box to
  answer in. `news:comment` is what opens it, and that capability is a resident's
  rather than a member's - answering a notice about the building one lives in is
  not the statutory right that membership carries, and membership adds exactly one
  capability in this platform. A partner, an adult child and a tenant therefore
  reach it exactly as a tenant-owner does, while the external property manager
  reaches neither the destination nor the endpoints behind it. The board's own
  `site:manage` adds the strike-through control to each comment and nothing else,
  so the writing screen and the reading screen stay two screens for two acts.

  The notices are served by a reader endpoint of their own, under the same
  capability as the thread. Which items a reader is offered and which threads open
  to them are one question, so one service answers both: what is on the list is
  what has a thread, a draft is on neither, and the identifier a thread is
  addressed by is the one the list carries. A body is narrowed to prose on the way
  out exactly as the website narrows it, and a link whose scheme this platform does
  not publish is dropped by the parser rather than by the browser.

  A struck-through comment is rendered as the server answers it, per reader, and
  the screen holds no rule of its own about who may read one. The comment keeps its
  place in the thread and its attribution in every case: with its text struck
  through for the board and for whoever wrote it, and with a sentence saying the
  board has withheld the text for everybody else. Striking one through changes
  nothing about who it is from, and a person with protected personal data is named
  to nobody either way. There is no control that clears a strike-through, because
  there is no endpoint for one.

  Nothing on the screen is optimistic. A posted comment and a struck one both ask
  for a fresh read of the thread rather than editing the list in place, one reading
  effect owns every read, and each row carries its own busy state - so after two
  acts crossing, what is on screen is the thread the server last described rather
  than whichever response happened to arrive last. Every refusal the endpoints can
  answer with has a sentence, and the personal identity number refusal names the
  rule without carrying the number back onto a screen the whole house reads.

- e7776cb: Read themes from the same catalog index plugins are read from.

  One index lists plugins and themes alike, in the format the plugin contract
  documents. The theme screen reads it through the same client as the plugin
  screen: the curated catalog when none is configured, the refusal of any other
  index unless the instance has opted out of curation, https only for a curated
  instance, and the digest checked before a package is unpacked. A theme's name
  and description in the catalog are shown in the viewer's language.

  An index in the earlier theme-only shape is no longer read. An index that lists
  the same id twice is refused as a whole.

  `@openbrf/plugin-sdk` exports the index's schema, `parseCatalogIndex`, and
  `pluginPackageProblems`, the check a plugin's own CI runs on its packed tarball.
  `@openbrf/theme-tools` exports `lintThemePackage`, the same check for a theme.
  The catalog token is sent to the index, and to an artifact only on the index's
  own origin.

- 8a0dbee: Harden the outbound connections to the SMTP server and the SMS gateway an
  administrator enters in the settings. A host that is, or resolves to, a
  loopback, private, link-local or other special-use address is refused when the
  settings are saved, with a message in English and Swedish, and again at each
  send. The connection is made to the address that was checked, and the host's
  name is still what TLS checks the certificate against. The SMS gateway is now
  reached through Node's own HTTP client rather than `fetch`, and an address
  carrying a user name or password is refused. Looking up the gateway's name
  shares one deadline with the request, so a lookup that never answers ends the
  send at the request timeout instead of leaving it pending.

  A relay or a gateway on a network the operator controls, such as the
  association's own LAN, needs the new `OPENBRF_ALLOW_PRIVATE_HOSTS=true`, which
  is off by default and mapped in `docker-compose.prod.yml`. Settings saved by an
  earlier version that name a private host stop sending until it is set. Servers
  set in the environment are not checked. The address rule is shared with the
  connected-app metadata fetch, whose behaviour does not change.

- 73ec00a: Let the board write the association's own website, with the publication
  guardrails inside the write path.

  Pages are edited from the application: paragraphs whose text can carry emphasis
  and links, headings, and pictures served from the instance's own origin. A page
  is written before it is meant to be read, so it is a draft until it is
  published, and it is either public or readable by anyone signed in - a page
  nobody may read is still answered exactly as one that does not exist. Writing
  the website is a capability of its own, granted to the board: publishing in the
  cooperative's name is what a board does, while how the instance is configured
  stays with an administrator. Reading the website needs no capability at all,
  which is what a public website is.

  What is stored is a list of blocks and never markup. The renderer decides what a
  block becomes, so no page can carry a script or an address off this instance
  into a browser: a link is limited to an ordinary web address, an email address
  or a page on this site, and a picture is stored as the identity of a file rather
  than as a URL. The editor is a mapping onto that format rather than a format of
  its own - what it produces is read out paragraph by paragraph on every change,
  and its own document is never stored - so a heading, a table or a colour pasted
  from a word processor is gone before it reaches a block. A body written by a
  later version renders as less on an older instance rather than as something that
  version cannot vouch for.

  The preview is the website's own renderer, given the draft and shown in a
  sandboxed frame. There is one renderer, so what the board approves is what a
  visitor is served.

  Three refusals guard what a page can carry. A personal identity number anywhere
  on a page - in the title, in the text, in a picture's description - refuses to
  be published, and the refusal names the block it is in without repeating the
  number. A picture declared at upload to show identifiable persons reaches a
  published page only after the board confirms that everyone recognisable in it
  has given publication consent. And a picture the instance no longer holds, or
  one that is not served publicly, is refused rather than left to appear as a
  broken picture on the street. A draft is deliberately not scanned: nothing on it
  is readable by anyone, and refusing to save half-written text would only move
  the writing somewhere with no guardrail at all.

  Publishing a page, taking one down and changing who may read it are each written
  to the audit log in the same transaction as the change itself, so the record
  cannot claim a publication that was rolled back or miss one that stood. A write
  that changes nothing writes nothing.

  Every instance now ships a privacy notice: a page at a fixed address carrying the
  headings a notice has to answer and no text under them, written when the
  cooperative is claimed, backfilled on the next start for an instance claimed
  earlier, and linked from the footer of every page the website publishes. The
  text is the association's own, like any other page, because what a particular
  cooperative does with personal data is not something a platform can write on its
  behalf.

  The editor warns, permanently, against writing about a named person's health,
  finances, religion, politics or family situation on a page the association
  publishes, and it says so before anything is typed rather than after something
  is refused.

- 2ea6f35: A connected app can now read and record what the association says about itself,
  the comment threads under its notices and the motion queue the board works - and
  the rules for an action that names a person are settled before the first one
  does.

  An action that can return a field of somebody with protected personal data
  (skyddade personuppgifter) is offered on this instance's own screens and nowhere
  else, and the registry refuses to register one that says otherwise. Read as a
  rule about what may be offered rather than about what must be declared, that
  decides more than it looks: an action worth offering to a connected app is one
  that cannot return such a field at all, which is a property of the service
  behind it rather than of what the action declares about itself.

  A withheld name now travels as a shape of its own rather than as an empty one.
  Something reading the answer can tell "the association is not telling you" from
  "the association holds nothing", which is the difference between asking a person
  and concluding there is nobody to ask about. An action that returns what a
  neighbour wrote says in its own description, in both languages, that the text is
  written by people and is information rather than instructions.

  Seven actions: reading and recording the association's own facts, reading a
  notice's comment thread and striking a comment through, and reading the motion
  queue, recording that the board has received a motion and recording which
  general meeting takes it up. Putting an item to the meeting stays a member's own
  act on their own screen.

  The motion queue is read a page at a time. It answered with every motion the
  association had ever received, bodies and all, in one payload; it now answers
  with a page and a cursor, and the board's screen has a control that asks for the
  rest.

  Saving the association's facts is recorded in the audit log. Those facts are on
  the broker information page the moment they are saved, so changing one changes
  what the association tells a buyer - and until now nothing anywhere said who had
  changed it.

  Two repairs to what a plugin and an action may reach. No action's handler may be
  bound to the service that writes the apartment register's append-only rows, and
  the test that enforces that list now reads every registrar in the tree rather
  than two named files. And the seal that decides what a plugin's own code may ask
  the framework for now covers every provider the platform shares application-wide
  rather than six of them - including the mailer, the text-message sender and the
  job queue, which a plugin is offered already in a narrowed form that carries the
  permission the board consented to. A check under `pnpm lint:guards` refuses a
  new application-wide provider that nobody has classified.

- 9e590ee: The consent step asks whether the plugin sends personal data outside the
  instance, and a screen install records the answer as the plugin's recipient.

  The API took the answer on install and wrote it into the association's record
  of who receives personal data (GDPR art. 28), but the screen never asked, so a
  plugin installed from it read as not classified until the board classified it on
  the data protection screen. The question now sits under the acknowledgement,
  with neither answer chosen, and nothing installs until it is answered. "No"
  records the plugin as a recipient that is no processor. "Yes" asks who the
  recipient is and whether it is a processor, whose agreement is then recorded as
  being made, or an independent controller, for which the reason no agreement is
  needed is asked as well. An answer carrying a personal identity number holds the
  install shut, because the record refuses one; the warning stands directly under
  the field that holds it, and that field takes the error border.

  The catalog entry says which personal data a plugin handles and not where it
  sends it, so the question is asked of every plugin, including one that declares
  no personal data at all, and the screen offers no answer of its own.

  Reinstalling or updating a plugin the record already classifies does not ask
  again, and neither does installing one that was removed: the step states what
  the record says and the install leaves it as it is, so an agreement the board
  completed on the data protection screen is not turned back into one being made.
  The catalog listing says, per plugin, what the record holds. A refusal of the
  answer names the part to correct rather than saying the install failed.

- 539c961: Add the `sms:send` plugin permission, so a plugin can send the members a text
  message as well as mail them.

  The permission set stopped at `mail:send` while the platform gained an SMS
  adapter, which left a plugin able to write to a member and not able to send one
  a text message. A plugin that declares `sms:send` receives `host.sms.send`,
  which takes the recipient number as `to` and the message as `text`, and hands
  them to the same service the SMS mailing uses: the sender name is the one on the
  housing cooperative's provider
  contract and is not a parameter, and the host adds nothing to the body, because
  a text message is billed by its length.

  It is a permission of its own rather than part of `mail:send`, because the two
  cost the housing cooperative different things. Mail leaves through a server the
  instance is already set up for; a text message is billed per message against a
  contract the board signed. The consent screen states that in as many words, so a
  board agreeing to a plugin writing to its members is not thereby agreeing to it
  spending that contract.

  An instance with no SMS provider cannot send at all, and the send fails rather
  than being dropped - the same answer the core's own SMS mailing gets, from the
  same service. Having no provider is the ordinary state of a housing cooperative
  that only ever mails its members, so a plugin whose work depends on SMS reads
  `host.permissions` and degrades, or treats the failure as the answer.

- 4b2deb9: Add the plugin system: manifest, loader, permissions-scoped SDK, catalog
  installation with a consent step, runtime-loaded views, and the `openbrf`
  command-line tool.

  A plugin is installed from the curated catalog as a tarball verified by its
  sha512, and the board sees what it may do and which personal data it will
  handle before agreeing to it. Installed plugins contribute a NestJS module,
  imported into the application at start-up with its controllers mounted under
  the plugin's own prefix, inside the application's authorization guard and at
  the capability floor its permissions imply; a React view loaded at runtime
  without rebuilding the application; background work on namespaced queues; and
  a settings form the host renders from their declaration. Their Swedish and
  English strings are merged at runtime under a namespace of their own.

  A malformed or refused plugin is skipped and reported rather than allowed to
  stop the instance, and the install flow is idempotent: the database holds what
  should be installed and the data volume is reconciled to it.

- 1ba7384: Give every processing the instance performs its row in the record of processing
  activities, and let the portability export carry only what art. 20 reaches.

  The record gains nine rows: the board mailbox, subletting applications, key
  orders, charges, comments on news, positions of trust and system roles, requests
  about own data, personal data breaches and legal holds. Each states its purpose,
  its legal basis with the statute behind it, whose data it is, who receives it and
  how long it is kept. They appear on every instance at the next start, in the
  association's own language; a row the board has edited is left as the board
  wrote it.

  Every section of the data subject access report now names the processing in the
  record that covers it, and the build fails on a section that names none, so a
  module that keeps personal data about a person cannot reach the report without
  its row.

  The portability export carries the sections whose processing rests on the
  membership or a consent: the contact details and residencies, publication
  consents, connected apps, bookings, motions, event sign-ups, subletting
  applications and key orders. Issue reports, the document archive, the chat,
  comments on news and requests about own data rest on the association's
  legitimate interest or on a legal obligation, so they are no longer in the file.
  They are on the data subject access report as before, and the file and the
  profile say where to find them.

  The mailbox the board mailbox collects from is now a recipient the data
  protection screen asks the board to classify. The record names the economic
  manager as the recipient of the charges and the fees, says that letters stay at
  the mail provider after a thread is erased, and no longer claims masking of
  protected personal data on the contact form, sign-up requests and the board
  mailbox, where whoever writes in is shown as they wrote.

- 47b1b9c: Protect the forms an anonymous visitor can reach.

  Every endpoint that accepts a submission without a session - asking the board
  for an account, activating an invitation, and creating the first administrator
  on an instance nobody has claimed yet - now sits behind a budget per client
  address. The budget refills continuously rather than resetting on the minute,
  it is spent by refused requests as much as by accepted ones, and a caller who
  empties it is told how long to wait. Budgets are held per route, so a script
  hammering one form leaves the others open, and each is set for the most
  demanding honest use of that form: several residents of one household share one
  address, and turning a resident away is a worse failure than a script taking a
  minute longer. Reading is never limited, and neither is anything behind a
  sign-in.

  The account request form also carries a field no person can reach - hidden from
  the screen, absent from the accessibility tree, and outside the tab order. A
  submission that filled it in is dropped and answered exactly as a stored one is,
  so nothing tells a script that the form has such a field or which one it is, and
  nothing it sent reaches the board's queue. What waits there is what a person
  wrote.

- b7da25f: Put the contact form and the issue report form on the association's website, as
  pages the board places them on.

  Both are plain HTML. A form posts to the page it was read on, the answer is a
  redirect back to that page, and the page shows a confirmation. Nothing runs in
  the visitor's browser, nothing is stored there, and no response sets a cookie -
  which means the forms work with scripting switched off, in every browser a
  cooperative's neighbours actually use. The content policy the website is served
  under gains one entry, `form-action 'self'`, which narrows it: a page on this
  website can only ever send what somebody typed back to the instance they are
  reading it on.

  A message to the board is stored before anything is sent. The board is notified
  by email afterwards, through the job queue and one job per recipient, so a
  delivery that fails is retried for that recipient and touches nobody else's -
  and an instance whose email settings are wrong keeps the message rather than
  losing it. The inbox in settings is therefore the record and the email is a
  notification about it. It is read by whoever decides sign-up requests, because
  that is the same board work: the two queues an anonymous visitor can put
  something into, and the board removes a message from it once the message has
  been answered.

  A report from the public creates an issue under a type the association offers
  non-members, and under no other: the identifier a submission names is checked
  against the same filter that decided what to show, so a type that was never
  offered is answered as if it did not exist. The report takes text and never a
  file. Contact details are optional and encrypted at rest, and the description
  carries the standing warning that health data and other people's details arrive
  in free text without anybody intending it.

  Whether the report form exists at all remains the board's switch. With it off,
  the block renders as nothing and the endpoint answers byte for byte what an
  address that names no page answers - so a page carrying the form survives the
  switch being turned, and closing the form is not an edit to the page. The same
  answer covers a form posted to a page that does not carry it and a form on a
  page an anonymous visitor may not read, which is what keeps a submission from
  being a way to find out which pages the association has.

  Both forms sit behind the per-address budget and the decoy field the public
  sign-up form already uses. A submission that fills the decoy is answered exactly
  as a stored one is, and is read before the association's own settings are, so a
  script learns nothing at all - not even whether this cooperative takes reports
  from the public.

- a9645d7: Serve the association's own public pages at the root, and move the application
  under `/app`.

  The address a housing cooperative gives out now belongs to that cooperative's
  own website. A page is stored as a title and a versioned list of blocks rather
  than as markup, so the renderer decides what a block becomes: a block type it
  does not know is skipped, and there is no block that can carry a script or an
  address on another host. The API renders the page as plain HTML, styled by the
  active theme - the token values, the typefaces and the association's own accent
  are assembled on the server and inlined, because the page runs no JavaScript to
  assemble them with. The typefaces are served from the instance itself, and the
  content security policy names no script source at all, so a public page runs
  nothing, sets no cookie and fetches nothing from any other host. That is also
  why the site needs no cookie banner.

  A page can be marked member-only. Anyone signed in reads it; everyone else gets
  the same not-found document, byte for byte, that an address with no page behind
  it gets - so a visitor with no account cannot learn from the refusal that the
  page exists. Reading the session never writes one back: no response from the
  website carries a cookie. The public rendering path reaches neither the
  statutory registers, the address book nor the encryption layer, and the
  integration suite holds it to that by scanning every page it serves for the
  shape of a personal identity number.

  Finishing the setup wizard writes the association one page, in the
  cooperative's own language, so a claimed instance answers its address with
  something. An instance claimed before this change keeps a not-found at the root
  until a page is created; the page editor is a later change.

  The application is served under `/app`, and everything that mints a link into
  it now says so: the emailed activation link, the two email templates that point
  at the application, the sign-in link on the website and the landing page after
  a sign-in link is verified. An unclaimed instance still sends every visitor at
  the root to the setup wizard.

- 19b048a: Publish the platform as a container image. Every release is built for amd64 and
  arm64, tagged with its exact version and its minor line, and carries a build
  provenance attestation naming the commit and the workflow that built it. The
  production Compose file runs the published image at the release line an
  operator chooses, and an upgrade is a pull and a restart.

  An instance names its version when it starts. Several instances can share one
  PostgreSQL server: each names its own application role, each database is closed
  to every other role on the server, the size of the connection pool is a
  setting, and the application role may hold that pool, the job queue's and three
  connections more. A start refuses a server where that isolation would not hold:
  an owner that is not the database's, a non-superuser owner on PostgreSQL older
  than 16, or an application role another database already grants. It also
  refuses a `DATABASE_URL_RUNTIME` that signs in as another role than the one
  `RUNTIME_DB_PASSWORD` has it constrain, one that signs in as the owner, one
  with a `user` query parameter and one that names no user. A `DATABASE_URL` with a
  `user` query parameter or no user is refused too.

  Upgrading an existing instance: its first start closes the database to every
  role but the owner and the application role. A separate backup or monitoring
  role needs `GRANT CONNECT ON DATABASE <database> TO <role>` from the owner
  (docs/backup-and-restore.md, "Before an upgrade").

- 694c27b: Show the board which reports to the cooperative housing register
  (bostadsrättsregistret) are owed, tell it when a window opens, and produce the
  initial supply of the existing apartments.

  The obligation ledger records a deadline per reportable event. Nothing read it
  back, nothing said a deadline existed, and nothing assembled the data Lag
  (2026:485) 3 § makes an association give Lantmäteriet by 31 December 2027. All
  three now exist.

  ## The queue, and where "reported" lives

  A screen of its own, grouping the duties by what is still owed, what has passed
  its statutory deadline and what has been reported. A passed deadline is a state
  rather than a row further down a list: Lag (2026:484) 3 kap. 10 § lets
  Lantmäteriet order a late report in under penalty of a fine, so it is marked five
  times over - its own group, that group first, the state named in words, a count
  in a notice above the document, and the colour last and never alone.

  Recording that an anmälan reached Lantmäteriet writes **no register row**.
  `register_report_obligation` is append-only on both of the statutory tier's
  mechanisms, and the model's own comment already draws the line: the event a row
  reports cannot change and neither can the day the statute counts the window from,
  so discharging the duty is a separate later fact rather than an edit to the row. A
  `reportedOn` column would have meant relaxing both guarantees for one field. The
  audit log carries it instead, and it is not the weaker home: it has the same
  append-only trigger and its own `REVOKE` line, so the discharge is exactly as
  tamper-evident as the deadline it discharges, and it already records who stated
  it, about which duty, and when. What it adds is the day stated, which is the day
  Lag (2026:484) 3 kap. 2 and 3 §§ make operative - a registration is made "vid den
  tidpunkt då en fullständig anmälan kom in till Lantmäteriet". It also records the
  act as what it is: the anmälan is made outside the platform, so a column would
  read as a fact the system knows where an entry reads as a statement a named board
  member made. Two statements about one anmälan are therefore two entries rather
  than a conflict, and the queue reads the earliest.

  Reading the queue is deliberately not audited, and the writes are. A duty carries
  an apartment designation and two statutory dates and no personal data at all; the
  acts it is about each have an entry of their own; and it is the screen a board
  opens every time it meets, so an entry per read would bury the disclosures the
  log exists to record.

  ## The notice, when a window opens

  Every seat on the board is emailed in its own language, with the apartment, the
  day the window opened and the day the report is due, and with nobody's name and
  no personal identity number: a name in a mailbox is a name in every mail system
  the message passes through.

  The sending is queued rather than done on the register request, which is where
  every board fan-out in this application already lives. A board has as many seats
  as it has, each send is a separate SMTP conversation, and the register write has
  already committed - so an unreachable mail server would hold the response open
  for the sum of those attempts, and the retry that follows writes a second
  termination, because a termination carries no uniqueness constraint. The job is
  enqueued after the commit and inside a try/catch, which is the opposite of the
  move-out reminder's ordering and for the opposite reason: that reminder cannot be
  reconstructed, while this notice can, because the queue screen lists every duty
  whether or not anybody was written to. Its payload is one identifier and the
  handler reads the dates back from the ledger. The address is decrypted per send
  and lives in one local for the length of the call; the log names a failure by
  person id, obligation id and the class of what went wrong, never by address.

  ## The initial supply

  A documented file and a printable extract of the same rows, behind a capability
  of its own - `registerReport:export` - alongside `apartmentRegister:read` and
  `protectedData:reveal`. It is the second operation in the product that decrypts a
  personal identity number, after the data subject access report, and it is treated
  as that rather than as a download: nothing is produced until somebody presses the
  button, the entry names every person whose number the file carried, every column
  it has and how many rows of each kind, and a `PROTECTED_DATA_REVEALED` entry goes
  in beside it so that "who has seen these identity numbers" stays answerable from
  one action across the whole product.

  The supply is refused outright where the association cannot be identified in it -
  no association record, or no organisationsnummer, which Förordning (2026:898)
  2 kap. 4 § 2 registers and 3 kap. 1 § makes one of the sökbegrepp the register is
  looked up by. A file that identifies nobody is not a smaller supply but one that
  cannot discharge the duty, and produced anyway it leaves a download to mistake
  for a completed one. The property designation is deliberately not refused on
  beside them, because 4 § andra stycket makes it conditional and an absent one is
  a truthful answer. The screen names which detail is missing, since two of the
  three refusals are the board's own to fix.

  An audit entry naming everybody an act covered is what makes the act
  accountable, and the data subject access report prints an entry's context to the
  person it is about - including the entries where they were the actor. So the
  report now shows a reader their own membership of such a list and a count of the
  rest, rather than every other holder's identifier, which is what GDPR art. 15(4)
  is about. That narrows only what leaves the building on one document; the log
  keeps every identifier it was written with, and the change covers the acts that
  already carried these lists before this one.

  **The file's shape is Open BRF's own and not Lantmäteriet's**, and it says so on
  the screen. The föreskrifter that Förordning (2026:898) 2 kap. 2 § and 5 kap. 1-2
  §§ leave the technical interface to have not been issued, and the register is
  still being built. What is not invented is the content: the columns are the fields
  Förordning (2026:898) 2 kap. 3-7 §§ enumerates, as narrowed to the supply duty by
  that förordning's second övergångsbestämmelse.
  `docs/register-supply-contract.md` states each column, its statutory field, and
  every enumerated field an instance does not hold with the reason - so
  transforming this into the prescribed form, when there is one, is a mapping
  against a stable contract rather than a second reading of the statute.

  Two things about the content are worth naming. **Lien notes are inside the supply
  duty although they open no reporting obligation for the association**: that
  standing per-event duty is the lienholder's (Lag (2026:484) 3 kap. 5 §), while
  Lag (2026:485) 3 § puts the initial supply of the ones already recorded on the
  association. 13 § of that act reaches only a lien that had sakrättsligt skydd before
  Lag (2026:484) took effect and was not noted under 11 §, and such a lien keeps
  that skydd only if the data about it reached Lantmäteriet within six months of that
  act taking effect - so leaving one out of the supply can cost the lienholder the
  protection itself. And **a holder with skyddade personuppgifter has their address
  withheld**, with a column beside it saying so: a supply duty is not an exception
  to the protection, the name and the personal identity number are what identify a
  holder in a register keyed on those, and the receiving authority holds an address
  through Skatteverket. The alternative address the register keeps is not put in its
  place, because supplying it as the postadress a state register is to hold would be
  a statement nobody made.

- c9c9e4e: Record a grant (upplåtelse) as the event it is, and raise the reporting obligation it opens.

  A grant of a tenant-ownership was stored as a transfer with no seller, which is
  also what a transfer out of a hand the register never held looks like - and a
  register that began part way through a building's life is full of those. The two
  were the same row, so the platform could not raise the reporting obligation Lag
  (2026:484) 3 kap. 2 § lays on the association for the first without risking it on
  the second, and the apartment register printed "Upplåtelse" for both.

  `Transfer.kind` now says which. The board states it when it records the move, a
  trigger requires it of every new row and refuses an update that takes it away
  again, and a CHECK refuses a grant that names a seller, because the right comes
  into being and has nobody to pass from.

  That trigger replaces two NOT VALID CHECK constraints, this one and the
  agreement reference before it, and repairs what they did. NOT VALID exempts the
  rows already in the table only until something writes to one: PostgreSQL checks
  the whole new row on UPDATE, so the grandfathered transfers were exactly the
  ones whose membership decision could never be recorded - and that decision is
  the day their own reporting window opens.

  The obligation ledger gains `GRANT`. Its window opens on the day of the grant
  itself - the one obligation in that chapter that needs no second date
  recorded first -
  so it is entered by the transaction that records the grant rather than by a later
  act, which is the rule the ledger already held for the other two. The database
  checks the transfer's own kind against the obligation's, so a transfer cannot be
  put on the grant's clock or the other way round.

  A row written before the column existed starts without a kind, and nothing
  derives one for it: what such a row was is not recorded anywhere, and a guess in
  a statutory register is a statement nobody made. A board that knows may record
  it, and while it stays absent that row raises no reporting obligation.

  The screens follow. The move-in panel asks which event is being recorded and
  offers the previous holder only for a transfer; the apartment register prints
  "the register does not hold the seller" where that is what happened, and states
  that a grant is reported from the grant rather than offering to record a
  membership decision the server would refuse.

- c64fe4a: Turn each recorded register event into a dated duty to report it to the
  cooperative housing register (bostadsrättsregistret).

  Lag (2026:484) 3 kap. gives the association two weeks to report a register event
  to Lantmäteriet, and 3 kap. 10 § lets Lantmäteriet order a late report in under
  penalty of a fine. The dates those windows run from landed with the termination
  and the membership decision; nothing computed a deadline from them. A reporting
  obligation (anmälningsskyldighet) now does: one row per reportable event, stating
  which event it is about, the day the window opened and the day it closes.

  Which day that is differs by paragraph, and the ledger counts from the one the
  statute names rather than from a single convenient date. A transfer runs from the
  day the association decided on membership - 3 kap. 3 § andra stycket, "inom två
  veckor från det att bostadsrättsföreningen beslutat om medlemskap i föreningen" -
  and not from the transfer, which completes on the tillträdesdag and is usually
  the later day, so counting from it would state a deadline after the statutory one
  had passed. A termination runs from the day the bostadsrätt ceased (3 kap. 4 §)
  and never from the day the board typed it in, so a termination recorded late
  arrives with its window already open or closed, which is the true state and the
  one the fine attaches to.

  Each row is written by the same transaction as the register write it is computed
  from, never by a job that looks for events afterwards: a ledger assembled later
  is one that can be missing a deadline nobody notices is absent. The coupling runs
  both ways, so a register write whose deadline cannot be entered does not happen
  at all rather than committing without it.

  It joins the statutory tier on both of the mechanisms that tier uses. A
  BEFORE UPDATE OR DELETE trigger and a statement-level TRUNCATE trigger stop every
  caller including the schema owner; the runtime role is separately revoked UPDATE
  and DELETE, because a trigger is switched off by a table's owner and the
  application connects as a role that owns nothing. It is as strict as a
  termination rather than as a transfer: the event a row reports cannot change and
  neither can the day the statute counts from, so discharging the duty is a
  separate later fact about a report that was made and not an edit to the row.
  Every reference it carries is RESTRICT, because a deadline that lost the event it
  was about would be a false record rather than a shorter one. The database states
  the rest of the shape as well: the two weeks as a CHECK, so no writer can enter a
  window that is not fourteen days, one deadline per event as a unique constraint,
  the event reference matching the kind, so a row cannot report one paragraph's
  event on another paragraph's clock, and a trigger tying the row to the event it
  names - the apartment is the event's own, the day the window opened is the date
  that event carries, and a transfer with no recorded membership decision takes no
  row at all, because the paragraph gives no day to count from.

  Liens are deliberately absent and are not an oversight to correct. 3 kap. 5 §
  puts the anmälan on the panthavare, who signs it together with the pledgor, and
  6 § lets Lantmäteriet authorise one to register pledges on its own, so no lien
  note opens a duty for the association.

  A person's own duties appear on their data subject access report, for GDPR art.
  15(1)(c) rather than for the dates the transfer and termination sections already
  carry: the ledger is the association's only record that their data is to go to a
  recipient outside it. An obligation names a register event and never a person, so
  it is reached through the events already on that report rather than through a
  derivation of its own - and a transfer's duty reaches the acquirer alone, because
  its due date less fourteen days is the membership decision date the report
  withholds from the seller on purpose.

  This change records the duties and their deadlines. Nothing in it lists which are
  outstanding, tells the board when one falls due, or produces the file a report to
  Lantmäteriet would be made from. Two duties whose window the statute runs from
  the event itself rather than from a separately recorded date are also absent from
  the ledger - a transfer to somebody already a member or outside the membership
  requirement, and one where the bostadsrätt passed to the association under 3 kap.
  3 § andra and fjärde styckena - because neither is distinguishable from what an
  instance records today. The third of those cases, a grant under 3 kap. 2 §, was
  in that list until the register began recording which of its events are grants;
  a grant now opens its reporting obligation on the day of the grant itself.

- 4214b99: Record the register events and dates the cooperative housing register
  (bostadsrättsregistret) is reported from.

  Lag (2026:484) om bostadsrättsregister will make the association report three
  kinds of event to Lantmäteriet, each inside two weeks. It is enacted but not yet
  in force: it enters into force on a day the government sets, and that day has not
  been set. Its companion Lag (2026:485) om införande is in force from 1 January
  2027, and 3 § of it puts 31 December 2027 on the association's supply of what the
  register is to contain. Three of the facts those reports are built from had
  nowhere to live.

  A termination (upphörande) now exists as a record of its own. Lag (2026:484)
  3 kap. 4 § runs its two weeks from the day the bostadsrätt ceased, and 3 kap.
  10 § lets Lantmäteriet order a late report in under penalty of a fine. It carries
  the apartment, the day it took effect, the board's reference to what shows it,
  and the ground - of which there are two, because bostadsrättslagen as amended by
  Lag (2026:486) distinguishes two and no more: a föreningsstämma resolving that a
  bostadsrätt which has passed to the association shall cease (BRL 6 kap. 11 §),
  and the building the apartment is in being transferred or sold executively
  (BRL 7 kap. 33 §). Those two sections are also the only places BRL says a
  termination must be registered. The alternatives inside the second are one ground
  here: the statute states them in one sentence, with one consequence and one
  reporting duty.

  It joins the statutory tier, which means both of the mechanisms that tier uses
  and not just one. A BEFORE UPDATE OR DELETE trigger and a statement-level
  TRUNCATE trigger stop every caller including the schema owner; the runtime role
  is separately revoked UPDATE and DELETE, because a trigger is switched off by a
  table's owner and the application connects as a role that owns nothing. It is
  stricter than a transfer or a lien note, which keep UPDATE so a lien can be
  released and a mis-keyed entry corrected: a bostadsrätt that has ceased has no
  later state to reach. The apartment reference is RESTRICT and never SET NULL - a
  statutory event may not lose what it was about.

  Because nothing can take a row out again, the form that writes one sends a
  single request: recording is an insert rather than a refusal of a second value,
  so a resubmitted form would leave two records of one tenant-ownership ceasing
  and no way to remove either.

  A transfer now carries the day the association decided on the acquirer's
  membership. Lag (2026:484) 3 kap. 3 § andra stycket runs the transfer report's
  two weeks from that decision and not from the transfer, and the decision is
  minuted by the board and derivable from nothing else the platform holds - a
  transfer recorded without it cannot be repaired later, which is why the column
  lands before a pilot records real transfers rather than with the reporting
  screen. It is nullable, and an absent value is not a gap: the same paragraph runs
  the window from the transfer itself where the acquirer is already a member or
  falls outside the membership requirement, and its fourth paragraph does the same
  where the bostadsrätt passed to the association, so those transfers have no
  decision to date. Recording one is refused a second time rather than overwritten,
  because the date is the start of a statutory window - and the control that
  records it sends one request at a time, because the refusal of a duplicate would
  otherwise report the failure of the request that succeeded.

  The association's authoritative property designation now sits beside its
  organisation number. The register holds data about the bostadsrättslägenhet
  (Lag (2026:484) 2 kap. 1 § första stycket 1) which the association has to supply
  by 31 December 2027 (Lag (2026:485) 3 §), except where it can be taken from
  fastighetsregistret or lägenhetsregistret instead (6 §) - registers keyed on this
  designation. What the register holds about the association itself is now
  specified: Förordning (2026:898) 2 kap. 4 § första stycket registers its
  lagfarts- och tomträttsinnehav, and andra stycket - the last of that section's
  two paragraphs - reports fastighetsbeteckning, taxeringsenhetsnummer and
  fastighetstyp instead of that holding, where the buildings stand on land the
  association neither owns nor holds with tomträtt. The section is in force from 1
  January 2027 and all of it falls inside the supply duty above. The condition is
  answerable from what an instance already holds, because the association facts
  record whether the land is owned or held on a site leasehold. The other two
  fields are not modelled: they are needed to render a report and nothing here
  renders one. The prose the board writes for the broker information page stays
  where it is and keeps its purpose: nothing statutory is derived from it.

  All three are recorded on the apartment register screen, inside the acting
  transaction with an audit entry, and all three appear on the register extract - an
  entry listing holders and transfers with nothing saying the right itself ended
  would read as though the apartment were still held. The data subject access
  report gains a terminations section, derived through the tenant-ownerships the
  member register says a person held, the way the lien notes already are and on a
  boundary rule of its own: a termination dated the day a holding ended is normally
  what ended it, so it belongs on that person's report where a pledge dated the
  same day belongs to the other party.

  This change records the facts and nothing more. Nothing in it computes a
  deadline, keeps a list of which reports are due or outstanding, tells anybody
  that one has fallen due, or produces the file the first submission to
  Lantmäteriet would be made from.

- 2693aec: Complete Lag (2026:484) 3 kap. 3 §: every övergång gets the right reporting clock, or the right absence of a duty.

  That section is four rules and the register held one of them. A reporting
  obligation was raised only where the board recorded a membership decision, so an
  övergång to somebody already a member, to somebody outside the membership
  requirement, or to the association itself raised none at all - each of those
  looks exactly like a decision nobody has minuted yet. `Transfer.reportBasis` now
  says which case applies. The board states it rather than the platform inferring
  it, because which case an övergång falls in turns on facts about the acquirer
  this database does not hold; a trigger fixes it once stated, as it does the kind,
  because the deadline computed from it sits in an append-only ledger; and a row
  written before the column keeps its null and derives nothing.

  Where the statute assigns the anmälan to somebody else, no duty is recorded and
  the queue says whose it is. Första stycket puts the report for an övergång to a
  juridical person that acquired at an executive or forced sale while holding a
  lien in the bostadsrätt (BRL 6 kap. 1 § andra stycket) on that person. A row in
  the ledger would be a deadline the association does not owe on a table nothing
  can correct, and the board could never discharge it - but an övergång that simply
  vanishes from every screen cannot be told from one nobody has recorded, so the
  reporting queue lists it separately and names the anmälare.

  A registered överlåtelse that has been hävd or has gone back to the seller is a
  record of its own (3 kap. 3 § tredje stycket). Statutory tier and append-only on
  the termination's shape, beside the transfer it undoes rather than on it: both
  happened, and a register showing only one would state something that is not the
  case. Its duty carries **no deadline**, because that sentence is the one in the
  chapter that sets none - it says the association "ska anmäla" where 3 kap. 2 §,
  the rest of 3 § and 4 § each say "inom två veckor" - so the ledger's window CHECK
  now requires fourteen days of every other kind and a null of this one, and the
  queue states it as owed without a day.

  Förordning (2026:898) 2 kap. 4 § andra stycket's other two fields are recorded:
  taxeringsenhetsnummer and fastighetstyp, reported with the fastighetsbeteckning
  in place of the association's lagfarts- och tomträttsinnehav where its buildings
  stand on land it neither owns nor holds with tomträtt. Whether that is so is now
  recorded too, as register content beside the property designation. It is not read
  off the association facts page, and the earlier claim that it could be was wrong:
  the boolean there says whether the land is held on a site leasehold, so false
  means the association owns it and the page has no value at all for the case the
  paragraph turns on.

- 3a515aa: Correct the registers, fees, charges, key orders, subletting and the member
  import where they could record or report the wrong thing.

  **Operators:** after upgrading an instance that recorded moves or ran a member
  import before this release, run `openbrf member-register reconcile` once, read
  its report, and then run it with `--apply`. It appends the member register rows
  that an older register is missing and changes nothing else. See
  `docs/member-register-reconciliation.md`.

  Registers and moves:

  - A transfer or a grant is recorded only for a tenant-owner, on both sides of
    the move, and an apartment is granted once.
  - The initial supply to Lantmäteriet leaves out the holders of an apartment
    whose tenant-ownership has been terminated, takes the membership decision
    from the transfer that began the current holding, and lists apartments in a
    fixed order, as the apartment register extract now does too.
  - The member register extract no longer lists an apartment against a
    membership that began on the day the apartment was left.
  - Removing an address that gains an apartment at the same moment answers with
    the refusal rather than a server error.

  Fees:

  - A fee rate cannot be recorded from a day a notification run has already
    billed, and a rate that no run billed can be removed even when a run's period
    covers its days.
  - A run is refused, rather than failing, when a notice would exceed what an
    amount can hold, when its payment references would repeat a run's from a
    century apart, or when its period is older than notices are kept for.
  - A protected person living in an apartment withholds the household's names on
    the fee notice, whether or not they hold the tenant-ownership.
  - Closing a fee rate stamps the financial year it ends in.

  Charges, key orders and subletting:

  - A correction that sends the VAT treatment again keeps the stored rate.
  - A charge cannot be dated before the seven years charges are kept for.
  - The debiting list export's audit entry records how many rows it held.
  - A key order or a sublet application can no longer be revised once the
    applicant has moved out of the apartment.
  - A sublet period may end at most five years ahead.
  - Every nightly purge runs at a minute of its own.

  Member import:

  - The preview names each row by its row in the uploaded sheet.
  - The upload's sample rows hide personal identity numbers.
  - A ten-digit identity number gets its century from the whole birth date.
  - Whether a residency has ended is judged on the association's calendar day.
  - A quoted CSV field after a space, and a header title with a line break in
    it, are read correctly.

  Every CSV file the platform writes also quotes a cell holding a comma or a tab.

- bfbfeca: Add the statutory register views, the move flows and the import.

  The member register (EFL 5 kap. via BRL 9 kap.) and the apartment register
  (BRL 9 kap.) render as two separate documents with two separate endpoints and
  two separate screens. The member register extract carries name, postal address,
  apartment linkage and the membership dates, and never a personal identity
  number: it is public on request. The apartment register carries the apartment
  designation, its holders, the initial share capital, the participation share,
  lien notes with their dates of record and transfers with their agreement
  references; it is confidential, open to the board and to each tenant-owner for
  their own entry. Identity numbers arrive masked, and producing the full
  statutory copy is a separate request whose audit entry names everyone it
  disclosed and why it was asked for. The board's copy carries every holder's
  number; a tenant-owner's own copy carries theirs alone, because an apartment
  lists its co-holders and its previous holders too. Noting a lien and releasing
  one are recorded in the audit log like every read of the register, and a note
  that already carries a release date keeps it: that date is the statutory date
  of record on a row nobody can delete. Both extracts print through a print
  stylesheet rather than a PDF engine.

  Move-in creates the residency, writes the member register entry when the person
  takes over a tenant-ownership, records a transfer when there is one, and sends
  the welcome email in the recipient's own language. Move-out sets the date,
  computes and displays the purge date from the retention policy, records the
  transfer, and closes the membership in the register when the person's last
  tenant-ownership ends. A job on the move-out date sends the board a summary, and
  that job is written by the same transaction as the register rows, so a move-out
  that is recorded is a move-out the board will be reminded of. A message that
  cannot be delivered is reported by residency and by the class of the failure,
  never by address and never by what the failure was carrying.

  Every path that writes the member register reads the person's other residencies
  to decide what to write, so each takes that person's transition lock before it
  reads: two move-ins arriving together record one membership rather than two
  entries in a register that refuses to have rows removed, and an import chunk
  overlapping a move-in records that same one. A chunk writes for many people at
  once and takes their locks in a fixed order, so two of them cannot deadlock. A move-out closes the residency
  with a conditional update, so the second of two requests on the same residency
  is refused rather than closing the membership a second time. A transfer is
  recorded only with a reference to its agreement - a case number, or where the
  paper copy is filed - because the apartment register extract states one for
  every transfer it lists and a transfer cannot be deleted once written. The
  database requires the same, and the extract names a transfer recorded before
  that requirement as having no reference rather than printing an empty space.

  Import reads a CSV file or an Excel workbook, guesses the column mapping from
  the titles in either language, and shows what would happen - creates, updates,
  rows with problems named one by one, and rows matching more than one person,
  which block the import until somebody decides. Persons are matched by personal
  identity number, then email, then apartment and exact name. An update fills in
  what the register does not have and never overwrites what it does. A personal
  identity number costs 43.8 ms to index by design, so writing the register is a
  background job that walks the file in chunks rather than work done inside the
  request: the screen shows the rows done against the rows the file holds, the
  page can be closed while it runs, and an import interrupted by a restart carries
  on from the chunk it reached rather than writing anything a second time. If the
  mapping or a decision refuses an import, it stops there and is reported under
  that reason. Only a failure another attempt could survive is retried, so an
  import reported as interrupted is one that really was. The import that runs is the one
  that was previewed. Starting it claims the upload with a conditional update so
  two applies of one upload cannot both queue it, and each chunk claims its place
  in the file the same way, in the transaction that writes it. Uploads are deleted
  once they expire, and a template is downloadable in the reader's own language.

- 3f34097: Add the two remaining resident-initiated forms: subletting applications
  (andrahandsupplåtelse) and key orders (nyckelbeställning). Each arrives whole -
  the table, its two capabilities, the resident's intake, the board's queue, the
  screens, the section on the data subject access report and the nightly purge -
  and the pair is one change because the interesting thing about them is the
  contrast.

  Subletting is the tenant-owner's. BRL 7 kap. 10 § första stycket lets a
  bostadsrättshavare let _sin lägenhet_ in andra hand for självständigt brukande
  only with the board's consent, so `sublets:apply` is derived from membership the
  way `motions:submit` is: a partner, an adult child or a tenant living in the flat
  is offered no form. The apartment named in a request has to be one the applicant
  holds, asked of the register at the moment of the request, which is what settles
  the administrator case - a grant on an instance carries every capability the
  model defines and no tenant-ownership at all.

  Ordering a key is the household's. Nothing in BRL or EFL gives anybody a right to
  one, so `keyOrders:place` follows residency the way `bookings:book` does and the
  same person who is offered no subletting form orders a tag exactly as a member
  would. The board may decline an order, which the motion queue has no equivalent
  of: refusing to take up a member's item is not the board's to decide under EFL
  6 kap. 15 §, and refusing a household a fourth tag to the bike room plainly is.
  Neither decision follows from the other, and both are stated where they are made.

  What the platform does not decide is stated instead of guessed. 10 § andra
  stycket (Lag 2026:776) makes a letting of the apartment or part of it always
  count as independent use where the holder no longer uses it as a permanent home
  or otherwise in beaktansvärd utsträckning - a fact about how somebody lives, so
  the form states the rule and nothing here concludes that consent was needed. The
  two cases in 10 a § where no consent is needed at all are outside the module and
  said to be: both holders are juridical persons - a lienholding company after a
  forced sale, and a kommun or a region - and neither has a resident account to
  reach a form with. And where the board refuses, 7 kap. 11 § lets the hyresnämnd
  permit the letting anyway; the platform cannot know that unless somebody records
  it, so a permission is written down beside the refusal and changes nothing else.
  The status stays refused, because the association did not consent and the
  tribunal permitted, and those are two facts about one letting. Only a permission
  is recorded: a refusal by the tribunal leaves the board's own refusal standing,
  which the row already says.

  Both forms carry the personal identity number guardrail on the way in and on
  every later edit, against the resident's own text and against the board's note
  alike - both are quoted back and both are printed in full on an access report -
  with the field named and the value never echoed.

  A key order carries no amount, no price and no invoice. What a key costs the
  member is a charge, with its own model, its own VAT treatment and its own export
  to whoever keeps the association's books, and a second place recording a sum
  would be a second answer to what the member owes. The same holds for the avgift
  för andrahandsupplåtelse BRL 7 kap. 14 § lets the bylaws provide for. The
  handover is its own audit action, so once the order has been purged the
  association can still answer that somebody was given a key to the building on a
  day.

  Retention is decided per feature rather than inherited. A key order is erased a
  year after it closed: the purpose ends when the key is in somebody's hand, and
  the year covers the accounting cycle the charge is settled in. A subletting
  application is erased two years after the _later_ of the answer and the end of
  the period applied for, so the association's record of a consent outlives the
  letting it covers - letting without consent is a forfeiture ground under 7 kap.
  18 § 2, and a purge anchored on the answer alone would erase the evidence while
  the tenant was still in the flat. An open request of either kind is never purged,
  and a legal hold stops both for the person it stands against, re-checked inside
  the deleting transaction under the advisory lock so a hold placed while a run is
  in flight wins.

- a1eaf25: A write built on a copy somebody else has replaced is refused rather than
  applied.

  Saving a page has been refused on those terms since the page editor gained its
  revision counter. Publishing a page, changing who may read it and deleting one
  were not: a board member who opened the website editor, went to a meeting and
  came back could publish a page on the strength of a version a colleague had
  rewritten in the meantime, or delete one - and a deletion has nothing to read
  again afterwards. All four now carry the same precondition and answer with the
  same sentence, which says what the board has to do: look at the page that is
  there, and decide again.

  The record of processing activities gets it too. GDPR art. 30 asks the
  association to keep that record accurate, and it is edited as a whole, so two
  board members correcting the same processing meant the second save silently
  replacing the first. It is now refused with a conflict rather than applied.

  Two smaller holes in the same mechanism are closed. Appending the missing
  art. 13 headings to the privacy notice rewrote the page without moving its
  revision, so a board member holding the page editor open would have had their
  save accepted and the appended headings quietly discarded. And ending a
  processing checked whether it had already ended outside the transaction that
  ended it, so two board members ending the same one at once could both be told
  they had done it.

- 91f0d05: Confer and revoke a role from the application: a board seat, the administrator
  grant and the external property manager grant.

  The authorization model was already enforced and had no write path. A residency
  and its member or resident role were written by the move-in, by the import and
  by an approved sign-up request, but a board seat and the two system roles had
  no screen and no endpoint, so a housing cooperative entered them as SQL, which
  also meant a second administrator could not be created and an instance that
  lost its only administrator had no way back in.

  Who may confer what is a capability rather than a role check, like everything
  else in this codebase. Recording an election to a position of trust is the
  board's own: a board is elected by the general meeting, the application holds
  the minute of that election, and an instance whose board could only be recorded
  by an administrator would make the administrator the gatekeeper of the
  association's constitution. The seat it writes carries nothing its writer does
  not already hold, so it cannot be used to climb.

  Granting a system role is an administrator's, and the board holds no capability
  that reaches that table. A board seat is therefore not a way to grant oneself
  administrator rights, and the guarantee is that no route exists on which a board
  member can write the grant rather than that a check inside one refuses it. The
  external property manager grant sits on that side with the administrator grant,
  although what it confers - the issue queue, and never the address book - is a
  subset of what a board member already holds: it is a standing grant to somebody
  who neither lives in the building nor was elected to anything, which is the same
  kind of decision as installing a plugin. It also keeps the board away from that
  table entirely, which is the point.

  A position of trust is history rather than state. An election carries the date
  the meeting was held, not the day somebody typed it in, and ending a term writes
  the date it ended and leaves the row where it was: who answered for the
  association between two dates is exactly what a seat records, and a table that
  deleted the row when the term ran out could no longer answer for the years it
  covered. A re-election is two acts rather than an edit, so both periods stand
  with their own dates; a second election onto a seat still held is refused rather
  than merged, because one row cannot carry two elections.

  An end date ahead of today is an ordinary date, so a board can minute in April
  that a term runs to the annual meeting and the access follows it without anybody
  remembering to come back. Which is exactly why it is bounded and why it can be
  corrected: the seat goes on conferring what a board member holds until that date
  arrives, so a term recorded as ending in 2206 rather than 2026 would confer it
  for the rest of the instance's life. A date past a plausible horizon is refused
  with a sentence saying to check the year, and a date that has not yet arrived
  can be written again from the same screen, which is what makes a mistyped year
  recoverable without a hand in the database. Once the date has passed the term is
  settled: the seat stopped conferring on that day, and the period it covered
  stands as recorded.

  A system role is a fact about today, so a revoke removes the row and the audit
  log is what remains to say who held what and between when. A change that changes
  nothing writes nothing, which is the rule the protected personal data flag and
  the publication consents already follow: granting a role that is held answers
  with the state as it is rather than putting a date in the record that nobody
  chose.

  The instance cannot be shut from the inside. The last administrator cannot be
  revoked, including by that administrator revoking their own grant, which is how
  it would actually happen - somebody tidying up their own account rather than
  removing a colleague. The count is taken under a lock on the grant being
  changed, so two revokes racing each other cannot each see two administrators and
  each remove one. The refusal says to grant the role to somebody else first,
  because "try again" is advice that cannot work.

  Every election, end of term, grant and revoke is written to the append-only
  audit log in the same transaction as the change it records, with two new
  actions for the board seats beside the two system role actions that already
  existed. The screen is the person view in the register, beside the publication
  consents and the legal hold, and each half is offered only to whoever holds the
  capability behind it. A conferred role is in force on the next request with no
  account touched, because roles are derived from the register rather than stored
  on the account.

- 330d3c4: Refuse to start when the application's database role can still create
  temporary tables.

  A temporary table hides a table of the same name for the session that made
  it. The guard functions no longer read through the session's `search_path`,
  and the bundled deploy steps revoke `TEMPORARY` from the runtime role, but a
  deployment that manages its runtime role by hand only loses it when its owner
  runs the revoke. The startup check now asks the database whether the role
  holds `TEMPORARY`, and refuses with the `REVOKE` statement to run when it does.

  **Upgrade note:** a deployment that runs the bundled steps needs nothing. One
  that manages its runtime role by hand and has not run the revoke from the
  previous release's note does so before this upgrade's `up -d`, as the
  database's owner:
  `REVOKE TEMPORARY ON DATABASE <database> FROM <runtime role>, PUBLIC`. Then
  check that
  `SELECT has_database_privilege('<runtime role>', current_database(), 'TEMPORARY')`
  answers `f`: a grant made by another role survives that revoke with only a
  warning, and has to be revoked by the role that made it.

- 1a6e725: Take TRIGGER, REFERENCES and TRUNCATE away from the application's database
  role on every table in `public` and `pgboss`, and refuse to go on while a role
  other than the owner holds TRIGGER there.

  `CREATE OR REPLACE TRIGGER` asks for the TRIGGER privilege on a table, not for
  its ownership. The hardening script never granted it, but it did not revoke it
  either, so a grant made outside it - by an earlier tool, or a `GRANT ALL` by
  hand - let the application's role replace the triggers that keep the statutory
  archive append-only, and the one that guards `pgboss.queue`, with triggers that
  do nothing.

  - `harden-runtime-role.sql` now revokes the three privileges from the runtime
    role and from `PUBLIC` on every table in both schemas, and in the default
    privileges for tables created later. It then checks that none is left, and
    stops if a grant another role made has survived the owner's revoke.
  - The job schema install stops while any role other than a table's owner, or
    `PUBLIC`, holds TRIGGER on a table in either schema. It looks before pg-boss
    migrates and again after, so a table pg-boss has just created, which takes
    its grants from the owner's default privileges, is checked too. It does not
    revoke the grant itself, because a role that held it may already have
    replaced a trigger, and a person has to check that.
  - A production start refuses an application role that holds TRIGGER on any of
    those tables.

  **Upgrade note:** nothing Open BRF grants holds these privileges, so a
  deployment that runs only the bundled steps needs nothing. One where TRIGGER
  was granted by hand or by another tool stops at the job schema install, or at
  the application's start, until the grant is gone. Before upgrading, as the
  schema owner:

  1. List who holds TRIGGER on a table they do not own:

     ```sql
     SELECT n.nspname, c.relname,
            CASE WHEN g.grantee = 0 THEN 'PUBLIC'
                 ELSE pg_get_userbyid(g.grantee) END AS grantee
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(c.relacl) AS g
     WHERE n.nspname IN ('public', 'pgboss')
       AND g.grantee <> c.relowner
       AND g.privilege_type = 'TRIGGER';
     ```

     and the default privileges that would grant it to tables created later,
     with `\ddp` in psql.

  2. If any row comes back, check that the triggers on those tables are still
     the ones the migrations and the job schema install created, since whoever
     held TRIGGER could have replaced one:

     ```sql
     SELECT tgrelid::regclass, tgname, pg_get_triggerdef(oid)
     FROM pg_trigger
     WHERE NOT tgisinternal;
     ```

  3. Then, as the role that granted it, revoke it from each role listed, and
     from each default privilege that grants it, adding `FOR ROLE` and
     `IN SCHEMA` as `\ddp` shows them:

     ```sql
     REVOKE TRIGGER ON ALL TABLES IN SCHEMA public, pgboss FROM some_role;
     ALTER DEFAULT PRIVILEGES REVOKE TRIGGER ON TABLES FROM some_role;
     ```

- ca89fbc: Refuse a change sent with the session cookie from a page on another origin. A
  POST, PUT, PATCH or DELETE whose `Origin` is not the instance's `APP_URL`, or
  whose `Sec-Fetch-Site` names another site, answers 403 before the session is
  read. A request carrying neither header, which a browser page cannot send, is
  unaffected, as are reads.
- b202b27: Add the public request form and the board's review queue for self-signup.

  Someone who lives in the cooperative but is not yet in the register asks for an
  account at `/request-account`, reached from a link on the sign-in screen that
  appears only while the board accepts requests. The form asks for a name, an
  email address, an optional phone number, and the address and apartment number as
  free text. There are no pickers on purpose: the screen is served before sign-in,
  and a picker would tell anyone who loaded the page which addresses and
  apartments the cooperative has. What the screen says after a submission is what
  actually happened - no account and no entry in the register exist until a board
  member approves the request, and a second request from the same email address
  replaces the first rather than queueing twice. With the toggle off the screen carries a
  closed notice instead of a form, and a form left open in a browser when the
  board switches the toggle off turns into that same notice on its next
  submission.

  The board decides the requests in settings, beside the switch that produced
  them. Each waiting request shows the applicant, their email address, the claim
  exactly as it was typed, and the day it was made; the board picks the real
  address and apartment beside it and approves, or turns the request away with an
  optional reason. Approving creates the person, the residency and the invitation
  in one step and sends the ordinary activation email; it never grants membership,
  because holding a tenant-ownership is a matter of record rather than something
  granted by asking. The refusals that mean something particular say so: a request
  somebody else has already decided, one replaced by a newer one from the same
  email address, an apartment that has left the register, and an approval that
  committed
  but could not send its invitation because the instance has no email server
  configured.

  A public `GET /api/signup-requests/state` endpoint answers whether the form is
  open. It stands in its own controller with no capability on it, and discloses
  nothing the submit endpoint did not already: that one refuses an anonymous
  caller with the same fact before it reads anything else in the request.

- 25b80c5: Require the setup link to claim a fresh instance. Until now the first visitor
  to reach the setup wizard became the administrator. An instance now prints a
  setup link to its log when it starts unclaimed, or takes the link's digest from
  the environment where its host has provisioned one, and the wizard creates the
  first administrator only for whoever holds it. The link stops working once the
  instance is claimed or restarted, and the log says so.
- ca89fbc: Approve an account request under the same rules as a move-in.

  An approval always records a resident and refuses a request that asks for a
  role, since membership is entered by a move-in and its member register row. It
  takes the person's residency lock, refuses a second residency on the same
  apartment, closes a granted erasure request the move-in overtakes, and dates
  the residency by the calendar day in Stockholm.

  A request is linked to a person already in the register only when exactly one
  person has its email address; when several do, the approval is refused with
  `email-shared` so the board can sort out the addresses first.

  The first pending account request from an email address now stands: a later
  submission from the same address is answered as before and stored nowhere, and a
  partial unique index keeps one pending account request per address.

  **Upgrade note:** the migration that adds that index first deletes every older
  pending account request from an address that has a newer pending one, keeping
  only the newest. Such rows can only come from two submissions that arrived
  together, since a submission used to replace the pending account request from
  its address. They were never decided, but the form is anonymous, so they need
  not come from the same person: the deleted one may be the resident's own request
  and the one kept somebody else's claim. The deletion is not reversible. To see
  them before you upgrade, take a backup and list the pending account requests
  whose address has more than one:

  ```sql
  SELECT id, "firstName", "lastName", "claimedAddress",
         "claimedApartmentNumber", "createdAt"
  FROM signup_request
  WHERE status = 'PENDING'
    AND "emailIndex" IN (
      SELECT "emailIndex" FROM signup_request
      WHERE status = 'PENDING'
      GROUP BY "emailIndex" HAVING count(*) > 1
    )
  ORDER BY "emailIndex", "createdAt";
  ```

  An approval whose invitation is not sent, whatever the reason, is no longer
  reported as a failure. It answers `invitationSent: false`, and the board's queue
  says the person is in the register and needs an invitation from the person's own
  view.

- 1f7efd1: Add the four remaining insertable blocks to the association's website: the
  document archive, the board, the association's own facts, and questions and
  answers.

  Three of them carry nothing at all. What each one shows is read when the page is
  rendered, against whoever is reading it, so one stored page reads correctly for
  a visitor with no account and for a member without the page knowing which of
  them arrived. A document taken off the public shelf this morning is off the page
  this afternoon, a consent withdrawn today takes a name off it today, and a fee
  policy corrected on the board's own screen is corrected everywhere it stands -
  none of it an edit to a page.

  A document list follows the archive rather than the page it sits on. The
  archive already decides who may read a document, per document, and the block
  asks it with the reader's own account rather than with "is somebody signed in":
  a resident who is not a member is offered the public shelf, because the archive
  gives every document its own audience and the minutes and the annual report are
  kept for the members unless a board publishes one deliberately. The board's own
  shelf is on no page at all - every serve of one of those files is written to
  the audit log and gated by a capability, and the website is the one surface in
  the product that has neither, so a link to one would be an invitation nobody
  reading the page could follow and a hint about what the board holds. The board
  reads that shelf in the archive, signed in as the board. A block can be
  narrowed to one binder, and one that names a binder nothing is filed in renders
  as nothing rather than as an empty heading.

  A board roster publishes a name and an elected position, and nothing else. A
  person appears only with their own recorded publication consent for exactly that
  scope - agreeing to a photograph is not agreeing to this - and a person carrying
  protected personal data is never published, whatever they have consented to,
  because publication is what that protection exists to prevent. Somebody who has
  withdrawn a consent and somebody nobody has asked are the same answer to a page:
  absent, rather than masked or initialled. The decision is made in one place,
  outside the website's own code, and the website is handed the answer the way it
  is handed a menu - so there is no branch in the rendering that could name the
  wrong person, and no query in the website that could reach a resident's details.
  An association whose board has not been asked for its consents publishes no
  roster, and the block then renders as nothing.

  The association facts are the ones the broker information page is generated
  from, rendered by the same code onto a page the board arranged itself. One
  account of the association rather than two that could drift, and a question
  nobody has answered is on neither.

  The FAQ is the one block with content of its own, which is why it
  needs no screen behind it: a FAQ is the board's own writing about its own house,
  written on the page it is published on. It renders as a description list, so a
  screen reader announces each question with its answer, and every answer is on
  the page rather than folded away - it is a housing cooperative's FAQ, and it has
  to survive being printed and searched.

  The board inserts all four from the page editor, and the two that have nothing
  to configure say what they will publish: a roster is empty until the consents
  have been recorded, and a fact nobody has answered is not on the page. Nothing
  about the website changes otherwise. It still runs no script, sets no cookie and
  fetches nothing from anybody else, a document is fetched from this instance's
  own media route by the id of the stored file, and a page carrying a personal
  identity number is still refused publication - now including one typed into a
  question or an answer.

- 2b229e0: Put the association's calendar on its public website: a page at /kalender, an
  address per event, and a block the board can put on a page it writes.

  The calendar is read a month at a time, and the way between months is two
  anchors. A month is a query parameter, previous and next are ordinary links, and
  the reader's own back button works - the website's content policy names no script
  source at all, so a calendar that needed one would not run in a browser, and one
  that needs none can be read with JavaScript switched off, in a text browser, and
  from the address printed on a notice. Which month somebody is looking at lives in
  the address bar, because the website sets no cookie and keeps no session. The
  parameter is read strictly and clamped: a value that is not a month leaves the
  reader on the current one, and a month outside the year back and two years
  forward the calendar reaches is pulled to the nearest edge rather than refused -
  there is nothing there a visitor could have got wrong. At either edge no anchor
  is printed, because a link that answered with the month it was followed from
  would read as a fault.

  A month boundary is a wall-clock fact, like every other time in the calendar. A
  midsummer party starting at half past midnight on the 21st of June is 22:30 UTC
  on the 20th, so a month window worked out in UTC would file it under the month
  before for part of the year. The window is derived from the same conversion the
  dates themselves were written with, and it is asserted in both directions: the
  date is in the month it falls in and absent from the one before it.

  Which dates a reader is answered with rests on one thing, whether the request
  carried a session, exactly as it does for a page and a news item. There is no
  capability read on the public website and there cannot be. An event the board
  published to the street is on the calendar for everybody; one published to the
  members is on it for anybody signed in; a draft is on it for nobody. Asked for by
  its own address, an event that is not the reader's to see is answered with the
  website's own not-found document - byte for byte the same one an address naming
  nothing produces, and the same one the page routes send - so somebody holding a
  list of identifiers cannot tell an event that exists and is closed to them from
  one that does not exist. That is a property of the service returning a single
  null for all three cases rather than of the controller remembering to be careful.

  How many places are gone stands beside a date. Who has taken them never does,
  and that is enforced by the shape of the query rather than by what the renderer
  prints: the places are read as a filtered relation count, so the only thing the
  website can learn about a sign-up is how many of them there are, and no shape it
  is handed has anywhere to put a name. A withdrawal does not hold a place and is
  not counted. A date the board has called off says so - on the calendar page, on
  the event's own page and in a block on a page the board wrote, from one renderer,
  because a cancelled cleaning day shown as going ahead sends somebody down to the
  courtyard on a Saturday morning.

  The board puts the calendar on a page from the page editor and chooses how many
  dates it shows. The block carries no dates and no names, only that number: what
  it becomes is read when the page is rendered, against whoever is reading it, so
  one stored page shows a visitor with no account the events published to everyone
  and a member the members' ones as well. A page of an instance whose calendar
  holds nothing that reader may see renders no calendar at all rather than an empty
  heading - a page must not announce a calendar the association has not started
  keeping, and an empty heading is also how a visitor would learn that the members
  have dates they do not.

  The calendar is also offered as a menu destination, so a board arranges the entry
  that leads to it the way it arranges the news one, and both /kalender and
  /calendar are refused as page addresses: a page written at either would never be
  reached, and the board is told so while it is naming the page rather than
  afterwards.

- bf1cdae: Add the menu on the association's website: a top level, one level under it, and
  a visitor shown only what they could open.

  The board arranges the menu itself. An entry points at one of the association's
  own pages, at a page the platform generates - the news index, the broker
  information, the form for asking the board for an account - or at an address
  somewhere else, and it hangs either at the top level or under one entry that
  does. An entry taking a page takes the page's own title unless the board writes
  something of its own, because a menu is written to fit the width of a menu: a
  borrowed title is cut to that width, and one the board typed is refused past it
  rather than saved as words nobody wrote.

  Which entries a visitor is served follows from what each one points at, and
  never from anything stored on the entry. A page kept for the members is not
  named to somebody with no session: the entry is absent from their menu rather
  than shown and refused, so the navigation cannot become the thing that tells
  them the page is there - which is the argument the byte-identical not-found
  document already rests on, applied to the one part of the chrome that would
  otherwise list every address the association has. The not-found document itself
  carries the menu a visitor with no account gets, whoever asked for it, so the
  refusal stays one document for everybody. An entry for a generated page is left
  out while that page does not exist or its feature is switched off, so a menu
  survives an association changing its mind, and the account-request entry is
  offered only while the board takes requests and only to somebody who has no
  account yet.

  The menu is also the ordering of the site. The address at the root serves the
  menu's first page entry, so there is no separate home-page setting that could
  disagree with the menu, and an association that empties its menu still has a
  front page: the lowest-ordered published public page, as before. An instance
  that already had pages gets one menu entry per published public page in the
  order the pages sat in, so its front page does not move; a cooperative claiming
  a new instance gets the entry for its first page written beside the page.

  The dropdown needs no script, because the website runs none. On a narrow screen
  the second level is simply a list under its parent; on a wide one it is revealed
  by the pointer and by keyboard focus reaching the group, so tabbing onto an
  entry opens it and the next tab lands inside. The parent stays an ordinary link
  in both, rather than becoming a control that is also a link, and every target
  keeps the 44px touch height the rest of the product uses. An entry pointing
  somewhere else is a text link and nothing more - https only, and nothing is
  fetched from the other host while a page is being read.

- 654197e: Add the open SMS adapter, so a board can send an SMS mailing as well as a news
  mailing.

  Open is the load-bearing word. Sending is behind one interface with a driver
  behind it, the way file storage already is, and no SMS provider's package is a
  dependency of the application. The driver this release ships posts each message
  to an address the board provides, so the provider is whoever answers it - a
  commercial route, a gateway on the association's own hardware, or a few lines in
  front of either. A cooperative changes provider by changing a setting, and a
  driver written against a particular provider is a file beside the one that
  exists rather than a change to it. Nothing is sent until a board turns it on: an
  instance starts with no provider, and that is not a fault - text messages are
  billed per message, and an association that only mails its members is the
  ordinary case.

  Publishing a news item now offers both delivery channels, and offers them
  separately. The news mailing is on by default because it costs nothing and
  reaches everyone in the register with an address; the SMS mailing is off,
  because it is billed per member and reaches only those who have given the
  association a number. Each is claimed once and only once, by its own
  conditional update inside the publish transaction, so a board that emailed the
  members in the morning can still text them in the afternoon about the same
  notice and neither claim can be taken twice. Editing a published item touches
  neither.

  The delivery ledger carries the channel, so the two share one record of who the
  board addressed while each keeps its own claim. Each worker claims a recipient's
  row before it hands that recipient's message to a mail server or a provider,
  which is what makes a second copy impossible; the cost is unchanged and it is
  the other way round, a worker lost between the claim and the send takes that one
  message with it. Neither worker can reach the other's rows, and neither channel's
  retries or failures cost the other any: a gateway that is down does not spend
  the mailing's attempts, and a mailing given up on marks only its own rows.

  The recipients are the members the association can actually reach that way. A
  member without a number is not among the people it can text, so they are absent
  from that ledger rather than written into it and recorded as a failure. No
  number is ever carried in a job: the payload is one news id, and the worker
  decrypts each number where the message is composed, exactly as the mailing does
  with an address.

  On an instance with no SMS provider the news item is published all the same, and
  the board's screen says which of the two did not go out. The two channels
  are reported apart for that reason - a cooperative that mails its members and
  has never bought SMS must not read a column of failures as though the mailing
  had failed.

  An SMS mailing is a headline and the address of the article, in the recipient's
  own language, and never the announcement itself: it arrives unencrypted on a
  lock screen over a network the association does not run, so it carries nothing
  that was not published anyway. It is bounded, and the link is what survives the
  bound - a long headline is cut, the address never is. Once the members have
  been texted, the item's address is settled and a rename is refused, because
  that link is the only copy of it they have.

- 3e20013: Exempt an SMTP server from STARTTLS only at a loopback address, not by the name
  `localhost`.

  A server named `localhost` was signed in to without TLS when it offered none.
  The SMTP driver asks DNS what a name is before it reads the hosts file, and Node
  asks the network about `localhost` like any other name, so whoever could answer
  the instance's DNS could have received the sign-in in the clear. Only
  `127.0.0.1` and `::1` are exempt now, for the relay the environment sets and for
  the server the board enters, including settings saved before.

  An instance that sends through a server named `localhost` which offers no
  STARTTLS stops sending mail on this upgrade: every send fails with the reason
  `mail-tls-unavailable` and nothing, the password included, leaves the instance.
  Before upgrading, write that server as `127.0.0.1` or `::1` - in
  `OPENBRF_SMTP_HOST` for the relay, on the SMTP card for a server the board
  entered - or have it offer TLS, through STARTTLS or implicit TLS on port 465
  (`OPENBRF_SMTP_SECURE=true` for the relay). Send a test message from the SMTP
  card afterwards.

  The SMTP and board mailbox hosts are also refused when they hold a C1 control
  character or a Unicode line or paragraph separator, as they already were with
  any other control character. The hint under the SMTP card's TLS box no longer
  says the rule waits for a save.

- 4695ba8: Require TLS of the SMTP server a board saved before saving required it. The
  upgrade's migration holds those settings to the rule a save applies: a server
  that is not on the same machine has to upgrade through STARTTLS before the
  instance signs in.

  **Check your mail after upgrading.** A connection that starts in cleartext to a
  server that offers no STARTTLS, which sent mail before the upgrade, sends none
  after it: every send through it fails with the reason `mail-tls-unavailable`,
  and nothing, the password included, is sent. Send a test message from the SMTP
  card. If it fails that way, switch to implicit TLS (usually port 465) or a port
  that offers STARTTLS (usually 587). Implicit TLS and a server on `localhost`,
  `127.0.0.1` or `::1` are not affected.

  Settings that do not require STARTTLS anyway, such as those a data-only restore
  of an older backup brings back, are held to it all the same: the instance
  requires STARTTLS of a server that is not on the same machine when it sends,
  whatever the stored settings say.

- 07f7ce1: Require TLS of the SMTP server a board enters in the settings. Once the
  settings are saved, a connection that starts in cleartext has to upgrade
  through STARTTLS before the instance signs in, unless the server is on the
  same machine, so a server that does not offer it, or an attacker on the path
  who strips the offer, gets no password in the clear. A test message that fails
  because the server set up no encrypted connection says so, in English and
  Swedish, rather than pointing at the password.
- c71c849: Harden the archive store, the storage drivers and media files.

  - A cached archive is kept when its declared digest cannot be read, a failed
    write leaves no temporary file, and a `file:` source must be a regular file
    read up to the size limit.
  - The S3 driver keeps a path the endpoint carries, refuses empty, `.` and `..`
    key segments, does not retry a failing bucket ten times, and does not copy an
    upload. The local-disk driver refuses a key naming the uploads directory.
    `.env.example` names the bucket permissions needed, and the backup guide
    covers the bucket.
  - An upload and its audit entry commit together. A deletion removes an
    unencrypted copy the row still names first, and two deletions of one file no
    longer fail. A public file's cached copy is revalidated on every use.
    Public files were served as `immutable` before, so an instance behind a CDN
    should purge `/api/media/*` from it once after upgrading.

- 1d12038: Encrypt every stored file at rest, each under a key of its own.

  Archive documents, issue photographs, attachments mailed to the board, the
  website's pictures and the logo are sealed by the instance before they reach its
  disk or a storage bucket, with libsodium's `crypto_secretstream_xchacha20poly1305`
  in 64 KiB chunks. Each file's key is 32 random bytes, encrypted under the
  instance's key as the field `mediaFile.dataKey` and kept on the file's row, so
  there is still one key to hold. Whatever the file is, storage holds
  `application/octet-stream` under a key with no extension.

  Serving decrypts as the file streams and verifies every chunk before its bytes
  leave. A file answers only once its first chunk has verified, so a changed or
  unreadable file gets the same 404 as a missing one and an error in the log that
  names its id. A failure further in ends the transfer short. No range request is
  served.

  The checksum on a file's row, which is also its entity tag, is now a keyed hash
  of the file under a key derived from the instance's, so the database on its own
  cannot confirm that a known document is stored. Files stored before this change
  are encrypted once, when the instance starts and before it listens. A file that
  cannot be encrypted is left as it was, logged, and never served; a run that
  cannot be carried out stops the start. The unencrypted object a file replaces
  stays named on its row until its removal has succeeded, and every start retries
  it.

  The record of processing activities says the files are encrypted on each
  processing that stores them, once no stored file is left unencrypted.

  The encryption key is now backed up once, into two copies kept apart from the
  server and from the backups, and every recurring backup leaves it out: a backup
  that carries its own key opens every encrypted field and every stored file in
  it. `docs/backup-and-restore.md` has the procedure, including copying the key
  out and putting it back on restore, and the deployment guide, the README, the
  compose file, the environment examples and the key's log lines say the same.

  `sodium-native` 5.1.0 is a new dependency, pinned exactly; the field encryption
  keeps its own 3.4.1. See ADR 0015.

- 1898cd6: Let the board record that a consented subletting ended before its period did.

  A granted erasure request keeps a consent while its letting runs, and it took
  the period's last day as the end of the letting. A letting that stopped early
  held the request open, and kept the application, until the end of a period
  nobody was using. Nothing could shorten it.

  The board can now record the day the letting ended, on a consented row in the
  subletting queue or with `PUT /api/sublet-queue/:id/letting-end`. The day must
  fall inside the period consented to. A request against any other application
  is refused as `not-consented`, and a day outside the period as
  `letting-end-outside-period`. The board can clear the record again. Each
  change writes a `SUBLET_LETTING_END_RECORDED` audit entry.

  From the day after the recorded last day, a granted erasure request no longer
  waits for the consent. The two-year retention window counts from the later of
  the board's answer and the end of that last day (the day is inclusive: the
  letting runs through it). The period itself stays what the board consented to.
  The applicant sees the day on their own list, and the data subject access
  report shows it beside the period.

  Migration `20261010100000_sublet_letting_ended_on` adds the column, with a
  check constraint for the same rules.

- ee46048: Install themes as data-only plugins, with inheritance.

  A theme is a manifest, token values for both modes, bundled font files with
  their licences, an optional logo and a choice among the core's own view
  variants. It carries no code, so installing or switching one writes files and a
  row and needs no restart.

  The install path reads a catalog entry, verifies the package against the sha512
  the catalog states, reads the archive and runs the theme lint before anything is
  written. The lint is a gate: it refuses a theme that renders the statutory
  register below WCAG AA in either mode, one carrying anything executable, and one
  whose fonts are not bundled and licensed. A theme declares `extends` and states
  only what it changes; the default theme is built in, always inheritable and
  cannot be removed. An administrator previews an installed theme in their own
  browser session before activating it.

  `@openbrf/theme-tools` holds the manifest schema, the lint, `extends`
  resolution, the view-variant registry and the archive reader, so a theme
  repository's CI can run the same check the core runs at install time.

- 6e9a63e: Compose a theme in the admin interface.

  An administrator names a theme, chooses the theme it inherits from and changes
  the colours they want changed. Everything they leave alone is inherited, so what
  is saved is the handful of values they actually chose rather than a copy of the
  theme they started from. Radius, shadow, motion and the typefaces are not part
  of the form and are therefore inherited too; a composed theme bundles no fonts
  and selects no view variant of its own.

  The draft is applied to the composer's own browser through the same preview
  mechanism the theme screen uses, so nobody else sees a half-finished theme and
  nothing is written until it is saved. Contrast is measured in the browser while
  the colours are chosen, and the screen says what that measurement is: advice.
  The gate is the install lint on the server, which runs again on every save, so a
  composed theme that renders the statutory register below WCAG AA is refused
  exactly as a package from a catalog would be, with the same findings naming the
  pair, the mode and the measured ratio.

  A saved theme is an ordinary installed theme: it appears in the theme list, is
  previewed, activated and removed through the routes that were already there, and
  editing it composes it again at the next patch version, which recomputes what
  any theme inheriting from it renders. Composing needs no catalog, which is what
  makes it the answer for an association with nothing to install from. A theme
  that came from a catalog is not editable here, because the next update from that
  catalog would take the board's own values away again.

- f2f3f87: Add `TRUSTED_PROXIES`, the addresses or CIDR ranges of the reverse proxy in
  front of an instance. The rate limits on the public forms now read
  `X-Forwarded-For` only on a request from one of these, and from the right, past
  the hops those proxies wrote, so only what the instance's own proxies wrote is
  believed. The sign-in endpoints count the same address, so a request sent to
  the application's port past the proxy is counted by where it came from rather
  than by a header of its choosing. Left empty, the forms and the sign-in
  endpoints count each request by the address it came from, so every visitor
  behind an unnamed proxy shares one budget: set it when upgrading
  (docs/deployment.md, "Behind a reverse proxy"). A range of every address, such
  as `0.0.0.0/0` or `::/0`, is refused at start, since it would trust every client
  to say where it came from.

### Patch Changes

- 3e15661: Let an administrator abandon a member list import that is stuck.

  Only one import runs at a time, so an import left queued after its job was
  lost, or held applying by a hung attempt, refused every other import until the
  next restart or until the queue had spent its retries. An administrator can now
  end it from the import screen, or with `POST /api/import/sessions/:id/abandon`.
  The route needs `association:manage` on top of the address book capabilities
  every import route needs, so the board cannot use it.

  The screen keeps showing a running import after its upload's 24 hours are up,
  since that is when a lost job is most likely to be found. The import is
  recorded as stopped with `apply-abandoned`, and another import can be applied
  straight away. What it had already written stays in the member
  register. The job behind it writes nothing more: a chunk in flight is waited
  for, and a retry or re-queue that comes for the import later finds it stopped
  and does nothing. Each abandon writes an `IMPORT_ABANDONED` audit entry naming
  who did it, how many rows the import had reached, when it had started and who
  uploaded the file.

  An import that has written every row is not abandoned: the abandon is refused
  as `session-not-running`, and an import an earlier version left applying with
  every row written is marked applied instead. The last chunk of an import now
  marks it applied in the same commit that writes its rows.

- dbc309d: Keep the buyer's first fee notice off the seller's access report. The move-out
  date is the first day the seller no longer holds the apartment, so a period or a
  rate that starts on it belongs to the next holder.
- f408d9d: The address book's search field now stops at the 200 characters the search accepts. A longer search was refused, and the address book then showed its failed state without the search field, so the only way out was to reload the page. The limit is shared as `MAX_ADDRESS_BOOK_SEARCH_LENGTH` in `@openbrf/shared`.
- f408d9d: An apartment number ending in "00", such as "1000", no longer has a floor read out of it. No apartment on a landing is number zero, so the number does not follow the Lantmäteriet convention, and it is now stored with no floor instead of being listed under the entrance floor. The correction applies to apartments added from now on: a row written earlier keeps the floor it was stored with, and the board can remove an unused one and add it again to have it recorded without one.
- f2f3f87: Refuse a form-encoded (`application/x-www-form-urlencoded`) body on `/api/*`
  with 415. Every client of the API sends JSON, or multipart for an upload. The
  sign-in paths under `/api/auth`, where the OAuth token endpoint is form-encoded,
  and the public site's contact and fault report forms keep accepting it.
- f2f3f87: Serve the application under `/app` with a Content-Security-Policy: scripts and
  everything else only from the instance's own origin, inline style for the theme,
  and no framing by any site.
- dbc309d: Record two changes in the audit log: editing an archive document
  (`DOCUMENT_UPDATED`, with the fields that changed and the audience before and
  after, never the title), and changing how long data is kept after a move-out
  (`ASSOCIATION_RETENTION_RECORDED`, with the days before and after). A migration
  adds the two actions, and a person's access report labels them.

  Two edits of one document, or two changes of the retention period, arriving
  together are ordered, so each entry names the value its own change replaced.

- 933e778: Record who made six privileged writes in the audit log. Moving an issue between
  statuses, entering a move-in or a move-out, switching a plugin on or off and
  changing a plugin's settings wrote no entry, so the property manager, the board
  or an administrator could do any of them without a trace. Each entry is written
  in the transaction that makes the change and names the person who made it.
  The settings entry names the fields and never the values, and the issue entry
  leaves the reporter's words out. The access report prints the new actions in the
  reader's language.
- 933e778: Hold an apartment binder to its size bound when two files arrive together. The
  room left was counted before the upload and never again, so two filings that
  each fitted could both be written. The count is now repeated under an advisory
  lock on the apartment when the entry is written, and a filing that no longer
  fits is refused and its file removed.
- 808311e: Keep a board mailbox thread's retention clock at its newest message when a
  reply dated earlier arrives.

  A thread is kept for two years from the last message on it. When a reply joined
  a thread, the collector set that date to the reply's own Date header, whatever
  it said. The header is the sender's clock, so a reply dated long before the
  rest of the conversation - a client with a wrong clock, a letter held up
  somewhere, an answer to an old copy - moved a live thread's clock back to that
  day. A reply dated 700 days ago put a conversation from last week into the
  purge a month later, and the whole thread was erased while it was still going
  on.

  A reply now moves the thread's clock forward only, never back. The comparison is
  made in the database update itself, so two replies collected at the same moment
  cannot leave the older date on the thread.

- d627751: Fix several ways the board mailbox could lose a letter, block the mailbox or
  show a thread in the wrong state.

  - A letter the mailbox sends more of than the board mailbox fetches, though its
    listing said it was small enough, is recorded as read and left in the
    mailbox. The run ends there, and the next run collects the letters behind it,
    rather than every run stopping at the same letter. A letter that was still
    arriving when its time ran out is listed as too slow and tried again six
    hours later, since the connection may be at fault and not the letter.
  - A MIME part with no headers keeps its first paragraph. It was read as the
    part's headers, so a one-paragraph letter arrived empty.
  - A mailbox that fails after sign-in, while listing its letters, is reported
    as unreachable rather than as a server error. A mailbox's listing may now be
    up to 16 MiB, so one holding tens of thousands of letters is collected rather
    than refused on every run.
  - A reply whose sending stopped after it was claimed no longer reads as on its
    way for good. The queue retries it and then gives up, and the thread says
    that it is not known whether the answer went out, rather than that it did
    not. The same applies when the answer was handed over but could not be
    recorded as sent.
  - Reopening a closed thread sets its status from the newest message on it.
    A follow-up nobody has answered goes back to whoever had the thread, or to
    every seat, rather than to answered. Reopening a thread that is not closed
    changes nothing.

- 729ede4: Harden the collection of the board's mailbox further.

  A letter is set aside only when the database refused its values. Every other
  failure to store it - a server that is read-only after a failover, a deploy
  ahead of its migration, an internal error, storage that did not answer - is
  tried again on the next run. A letter that fails on every run for an hour and
  at least twelve times is then set aside, so it is not retried unseen for as
  long as the mailbox keeps it. Such a letter is tried again every six hours, so
  the letters an outage longer than an hour set aside are collected once the
  instance has recovered.

  The board's mailbox screen now lists the letters the collection set aside, with
  why, the date the letter carried and when it is tried again, so a board member
  can find them in a mail client. They are still in the mailbox. A letter deleted
  from the mailbox leaves the list at the next collection, and so does one that
  was stored after all, such as one two overlapping collections handled at once.
  A letter the purge erased, or one already past the retention window when it
  was read, is not listed: neither is the board's to go and read.

  A letter that was not stored no longer leaves its attachments behind in
  storage. A file is kept when a row names it, so a letter whose write landed
  although the database's answer was lost keeps its attachments. The audit log no
  longer records the file name of an attachment the collection stores or removes. An attachment that storage would not take no longer drops the file
  from a letter that is stored for good: the letter is tried again with it.

  The collection reads no more than four times the stored length of a letter's
  body, decodes no more of its bytes than that needs, and still says when a letter
  was cut. A letter written as alternatives nested inside each other is read in
  time proportional to its parts: each alternative used to be read twice when none
  of them was plain text, so every level of nesting doubled the work. A sender address carrying a control
  character is refused. Characters that reorder text are removed from attachment
  names, so a name cannot show as a different file type from the one it has.

- df42d47: Report a board mailbox thread to the person it was established to be with,
  rather than to whoever holds the address today.

  The data subject access report gathered somebody's correspondence with the board
  by indexing their current email address and taking every thread that matched.
  Nothing in the schema makes that an identification: a person's address index
  carries no unique constraint, and a thread records an address and no period over
  which it belonged to anybody. So the match answered "whoever holds this address
  now". Two ordinary situations gave the wrong answer. Two residents of one
  apartment who give the association the same address each received the other's
  letters to the board, and the board's replies about them. And an address later
  recorded for somebody else - a `styrelsen@` or `ordforande@` seat changing hands
  is the everyday case - put the previous holder's correspondence into the new
  holder's report. The document the association produces to demonstrate it handles
  personal data properly was the one disclosing.

  The identification is now the board mailbox's to make, and it is made once, as
  the letter arrives: a thread records the person the register then held that
  address for, and only where it held it for exactly one person. The report asks
  for the threads carrying that link. A thread nobody was established to be - an
  address the register does not hold, one a household shares, or one collected
  before this release - is in no report, which is the answer that discloses
  nothing rather than the one that guesses.

  The legal hold still matches on the address, deliberately. Holding a thread that
  turns out to be somebody else's keeps data past its window; releasing one that
  should have been kept destroys evidence the association undertook to preserve,
  and nothing recovers that.

  The art. 20 portability export is unaffected: it is an allow-list of named
  sections and board mailbox threads were never among them.

- 2bf7072: Recognise the board's mailbox by its host however it is capitalised or spaced in
  the settings. Correcting `Mail.Example.se` to `mail.example.se` no longer makes
  every letter still in the mailbox look new. Letters already collected under a
  host typed with capitals or spaces are carried over on the first collection
  after the upgrade, so nothing is collected twice. The user name is taken exactly
  as it is sent to the mail server, which decides what it means: two mailboxes on
  one server whose user names differ only in case stay two mailboxes.
- 2bf7072: Page the board mailbox inbox from where the last page ended rather than from a
  thread, so a thread taken or erased while somebody pages no longer makes the next
  page skip threads or come back empty.
- 863e5c0: Show the board all the text of a letter written in several text parts.

  Some mail clients write a letter as more than one text part. Apple Mail, for
  one, puts the text before an inline picture in one part and the text after it
  in another. The board mailbox read only the first, so the board saw the
  letter up to the picture, and nothing on the screen said that more followed.
  Every text part a mail client shows is now read, in order, with a blank line
  where a picture or file stood between them. The whole is held to the same
  length as one letter, and a letter cut at that length is shown as cut.

  Only plain text and HTML are read as the letter. A calendar invitation, a
  contact card, the headers of a bounced letter or a table sent as text is not
  added to the letter's text.

- 8e2574a: A thread in the board mailbox whose sender's domain holds a character that Unicode maps to a delimiter (a fullwidth comma, a parenthesised digit, a small comma) is no longer converted to punycode: the panel shows its warning that the domain cannot be converted, instead of a domain with a comma in it. Characters that are drawn as nothing, such as the combining grapheme joiner, the Khmer inherent vowels and the shorthand format controls, are now removed from names and refused in addresses, as the other invisible characters already were.
- b08a33a: A thread in the board mailbox whose sender's domain is written with letters outside A-Z now shows the domain the way a reply will address it (punycode), so a lookalike such as a Cyrillic "е" in place of a Latin "e" can be told apart before the board answers. A domain whose label mixes alphabets also carries a warning. A legitimate international domain such as `münchen.de` or `почта.рф` is shown with its punycode form and no warning, and the address itself is not changed.
- 541c0a6: A thread in the board mailbox whose sender's domain contains characters that cannot appear in a hostname (for example a space, a slash or a control character) is no longer converted to punycode. The panel now shows its warning that the domain cannot be converted, instead of a converted domain that a reply would not go to.
- 0a835aa: Harden the outbound connection to the board mailbox's POP3 server, which an
  administrator enters in the settings, the way the SMTP server and the SMS
  gateway already are. A host that is, or resolves to, a loopback, private,
  link-local or other special-use address is refused when the settings are saved
  and again at each collection, with a message in English and Swedish on the
  settings screen and on the board's mailbox screen. The connection is made to
  the address that was checked, and the host's name is still what TLS checks the
  certificate against. Finding the host's address now counts against the
  connection's own ten-second limit.

  A mailbox on a network the operator controls needs
  `OPENBRF_ALLOW_PRIVATE_HOSTS=true`. A mailbox saved by an earlier version that
  names a private host is no longer collected until it is set, or a public server
  is entered.

- a84f349: Collect a board mailbox letter made of millions of multipart parts without
  running the API out of memory.

  A multipart letter is split at each delimiter line, and the reader kept an
  object of about a kilobyte for every part. A delimiter and a line break are
  four bytes, so a letter inside the size limit the collector will fetch could
  hold more than two million parts and grow the API's heap by gigabytes. Anybody
  could send that letter to the board's published address. On a host with a
  memory limit it could end the process, and since nothing is deleted from the
  mailbox, end it again on every collection.

  One letter may now hold 1,000 parts, at every depth together. A letter written
  in text and HTML with files attached is a handful, and one with a hundred
  pictures is far below the limit. A multipart whose parts would take the letter
  past it is not split. It is shown as its source text, as a multipart nested
  deeper than the reader walks already is, so the board sees that this is not a
  letter as a mail client writes one, instead of a letter with part of it missing.

- 2bf7072: Harden the board mailbox's sign-in.

  The mailbox host, user name and password are refused when they contain a line
  break or another control character, both in the settings and again before
  anything is sent to the mailbox. A mailbox that answers the sign-in with
  `[IN-USE]` (another mail client holds it) or `[SYS/...]` (a fault on its side)
  is now reported as unreachable rather than as a wrong password, so the board is
  not sent to change a password that is right.

- 2bf7072: Remove the files of every letter the board mailbox purge erases, including a
  letter stored onto the thread while the purge was running.
- dbfb278: Keep a purged board mailbox letter erased.

  The collector never deletes mail from the board's mailbox, and it decides what
  it already holds from the POP3 identifiers it remembers. The retention purge
  erased a thread and its messages, and with them the only record of those
  identifiers, so a letter still in the mailbox could be collected again after
  its thread was purged.

  The purge now records the identifier of every letter it erases, in the same
  transaction, in the ledger of messages the collector will not store. The
  collector also leaves alone a letter that is already past the retention window
  the first time it reads it, and records it there too, so the letter is not
  fetched again.

- 863e5c0: Stop three ways a letter to the board mailbox could be left uncollected without
  the board seeing it.

  A letter's date is now held to when the mailbox received it, as its mailbox
  provider's Received header records. A letter whose own date lies before the
  retention window - from a device whose clock is years behind, or from somebody
  who set it so - was set aside as past retention, and the board's screen does
  not list those. It is now collected and dated by its arrival. A letter dated
  more than a day away from its arrival is dated by its arrival in either
  direction, so old mail in a mailbox is still left where it is when it is first
  collected, whatever date it claims. A letter with no Received header keeps its
  own date as before.

  A letter is no longer taken for a copy of the board's own answer just because
  it carries the answer's Message-ID. That identifier reaches the correspondent
  with the answer, so anybody the board had answered could write to it again
  under the identifier and the letter was never stored. A letter is now the
  board's own answer only when its subject and every form of its text are the
  answer as this instance renders it, and it carries no file and no other part.
  The plain text is compared word for word and the HTML as HTML, so a picture or
  styled text that a mail client would show beside the answer's words also makes
  it a letter. A copy that a mailing list or a mail service has changed is
  collected as a letter, so the board may see its own answer again; it no longer
  misses somebody else's letter. A copy of an answer too long for the collector
  to read whole is still recognised by the part that is read, which is all the
  board's screen shows of any letter. A letter cut short with less text than
  that is never taken for an answer, whatever its first lines say.

  Further copies of one answer are no longer fetched on every collection. The
  first copy is held under the answer, as before; each further one, which a
  mailbox that files sent mail or a board that copies its own address can leave,
  is now recorded as read. Before, enough of them filled every collection, and
  the letters behind them were not collected.

- 2bf7072: Send the board's reply without greeting the correspondent by the name on their
  envelope. That name is whatever the sender typed, and printed in a letter sent
  under the association's name it read as the association's own words. A reply's
  sending job is also given fifteen minutes before it expires, as the other mail
  jobs are, rather than five.
- 2bf7072: Set aside a letter the board's mailbox refuses to hand over, on the same bound as
  a letter that cannot be stored: after twelve failed tries over at least an hour
  it is listed on the board mailbox screen and tried again later, rather than
  fetched on every run for as long as it sits in the mailbox. A collection whose
  connection to the mailbox drops stops there, and counts nothing against the
  letters it had not reached.
- 2bf7072: Read the board mailbox's letters as their senders wrote them.

  A subject or a name sent as raw UTF-8 is no longer shown with each non-ASCII
  letter garbled into two others. The sender's address is the one after the
  display name even when the name itself carries angle brackets, so such a letter
  is no longer set aside for having no sender address, and an address in a
  comment after it, such as a forwarder's, is not taken for the sender's. An
  attachment whose name arrives in numbered RFC 2231 segments keeps that name
  rather than the numbered placeholder given to an attachment that has none, and
  a stray segment with no first one no longer replaces the plain name sent beside
  it.

  A From header that does not name exactly one sender is refused rather than
  read for whichever address came last: a list of addresses, a second address
  beside the first, or a comment left open after an address. The mailbox provider
  may have checked the sender's domain against another address in it than the
  one read here, so such a letter is set aside for having no sender address. A
  parenthesis left open in a display name, such as `Kalle :-(`, is still read as
  part of the name.

  Characters a reader cannot see (C1 controls, the soft hyphen, bidirectional
  controls, zero-width and word-joining characters, Hangul fillers, variation
  selectors and tag characters) are removed from a letter's subject, its sender's
  name and its attachments' names, and an address holding one is not accepted as
  the sender's address.

- 809d6c9: Collect a board mailbox letter made of millions of short lines without running
  the API out of memory, and read the headers of a letter that arrives behind a
  stray line break.

  The POP3 client kept every line of a response as an object of its own, while its
  size limit counted only bytes. A blank line is two bytes, so a letter of nothing
  else, inside the 10 MiB limit, grew the API's heap by more than 600 MB. Anybody
  could send that letter to the board's published address. On a host with a memory
  limit it could end the process, and since nothing is deleted from the mailbox,
  end it again on every collection. The client now copies each response into one
  buffer as it reads it, and reads the listing a line at a time from that buffer.
  The same letter now costs a few megabytes.

  The message reader had the same cost in its headers. A letter with no blank line
  in it is all header, and its header block was split into one string per line,
  with every header name in it kept. Millions of short lines there grew the heap by
  more than 130 MB. The reader now walks the header block a line at a time and
  keeps only the headers it reads.

  A part of a multipart letter may start with a blank line and carry no headers.
  Since the previous release, a whole letter that started with a line break was
  read the same way. Its real headers then became body text, and the letter was set
  aside as having no sender. Only a part is now read that way. At the start of a
  letter, the line break is skipped.

- 2bf7072: Keep a board mailbox thread's state consistent when two board members act on it
  at once. Taking, releasing, answering and closing a thread, and a follow-up
  reopening it, now wait for each other rather than one overwriting the other, so a
  reply sent as somebody closes the thread no longer leaves it answered and closed
  at once.
- 2bf7072: Join a letter to a board mailbox thread only when it answers one of the board's
  own replies on that thread, as the glossary defines a thread. A letter citing the
  correspondent's own earlier letter, whose identifier travels to everyone it was
  sent to, now opens a thread of its own.
- f07ebb2: Harden the collection of the board's mailbox against letters it cannot store.

  A collected letter's text no longer keeps control characters other than tabs
  and line breaks, whether they arrived as bytes or, in an HTML letter, as
  numeric character references. A letter the database still refuses is set
  aside and recorded as read, and the collection carries on with the letters
  behind it rather than stopping at it on every run. Only a refusal of the
  data itself sets a letter aside: a failure of the database - out of reach,
  restarting, out of connections or resources, a statement cancelled or timed
  out, a lock or a write conflict - or an error that is not an answer from the
  database at all is not recorded against the letter, which is tried again on
  the next run.

  Reading an HTML letter as text now takes time in proportion to the letter's
  length, however its whitespace is laid out.

- e881b32: Keep the 72-hour breach clock running until IMY has actually been notified.

  A board that decided IMY was to be notified, but had not yet recorded the
  notification, saw the breach as "Decided". The reminder stopped and the
  overview reported nothing waiting, although art. 33(1) still required the
  notification within 72 hours of discovery. Deciding to notify is not the same
  as notifying, and the register now keeps the two apart:

  - A breach decided with IMY to be notified and no notification recorded is in
    a new `notificationOwed` state, and turns `overdue` 72 hours after discovery,
    in the same way as an undecided breach.
  - The board reminder still goes to such a breach, and its text says the
    notification is owed rather than that nothing has been decided.
  - The overview counts these breaches (`notificationOwed`) and includes them in
    `overdue`. `nearestDeadline` is replaced by `nearestDecisionDeadline` and
    `nearestNotificationDeadline`, one for each count, and the overview strip
    names both counts with their own hours when both are waiting.
  - The register screen has a "Record the notification" action on these rows. It
    records when IMY was notified, IMY's reference if there is one, and the
    reasons for the delay when the notification was late. The action uses the
    existing `PUT /api/data-protection/breaches/:breachId`. The form opens on the
    reference already recorded, so saving only the date does not clear it.
  - A notified-at before the discovery or in the future is refused, on both the
    decision and the `PUT` (`notified-out-of-range`, 400), because a notified-at
    still to come would stop the clock with IMY told nothing. The date field
    offers only the moments in between.
  - A breach cannot be closed while the notification is owed
    (`imy-notification-owed`, 409), because closing would stop the clock in the
    same way.

- dbc309d: Retry the 48-hour breach reminder when the mail server is down, and send it
  once.

  A reminder that reached no board member because every send failed completed
  anyway, so a mail outage at hour 48 cost the board its only warning before the
  72-hour bound. It now fails and is tried again up to five times, starting after
  five minutes and doubling the wait. Saving a breach with an unchanged discovery
  time no longer queues a second reminder.

- 933e778: Stop resending the breach reminder to board members it already reached. A
  discovery time corrected from A to B and back to A queued two reminders that
  both fired, and a send that reached some of the board and failed for the rest
  was retried for all of them. The reminder now records, under the breach's lock,
  who it reached for each discovery time (a time corrected from A to B and back
  to A finds A's receipts still there), mails each member under that lock, retries
  only the members not reached, stops when the board answers meanwhile, and logs
  once when the last retry gives up. Delivery is at least once: if recording a
  member fails after their mail has left, the retry mails them again.
- a1eaf25: Every date the association states is now read on the association's own calendar.

  Sweden runs an hour ahead of UTC in winter and two in summer, and Open BRF was
  reading the day off the clock in Greenwich. For that hour or two after midnight,
  every date produced from a moment named the day before: a register extract taken
  at half past midnight on the 6th of March was stamped the 5th, on a document
  handed to a member or an authority.

  The statutory extract of the member register, the statutory extract of the
  apartment register, the access report a person is entitled to under GDPR
  art. 15 and the address book export are all stamped with the day they were
  produced here. So are the dates a data subject request was decided, executed and
  closed, on the board's own queue and on the report alike, and the days a
  publication consent was given and withdrawn - a consent withdrawn at twenty to
  eleven on a summer evening was recorded as withdrawn the day before.

  On screen, an issue report, a motion, a comment, a contact message, a sign-up
  request, a key order, a sublet application and a news item all show the day they
  actually happened here. So does the discovery date of a personal data breach,
  which is the date the 72 hours of art. 33 are counted from, and the board seat
  panel no longer offers to end a term that has already ended. The charges screen
  read the reader's own clock, so a board member abroad was offered a charge date
  the association then refused, and on the 1st of January the wrong year; it reads
  the association's day now.

  Dates that were already days - a move-in, a meeting, a period - are unchanged.
  Those carry no time and no zone, and reading one in a zone would be a new way of
  getting it wrong.

- 68a7471: Refuse a catalog entry whose digest is not written as `sha512-<base64>` or 128
  hex characters.

  `parseCatalogIndex` now reads each artifact's `sha512` with the same
  `parseSha512` an instance verifies a download with, so an index with a badly
  spelled digest is refused whole, naming the field, instead of being accepted and
  failing at install time. An index that parsed before and carries such a digest
  no longer does.

  A theme catalog with such an entry is therefore refused as unreadable. The theme
  source also keeps a separate `malformed-digest` refusal for an entry that did
  not come through the index parser, so a digest that is badly spelled is never
  reported as a package that does not match its checksum, which suggested the
  download had been tampered with.

- ca89fbc: Put into a chat group only somebody the group's picker would offer. A person
  with protected personal data, somebody who has moved out and an identifier
  that names nobody all get the same `not-a-resident` refusal.
- 4648a19: Putting somebody into a group twice at the same moment, when that group is
  their twentieth, now answers both presses with the member list. Before, the
  second press answered `too-many-groups` even though the first had already put
  them in. The limit of twenty groups per person still holds for two presses
  putting one person into two different groups.
- dbc309d: List only the members of a chat group who live here, and count only them
  against the group's size. Someone who had moved out stayed listed and took up a
  place until the night's purge.
- 990eb88: Erase a person's chat messages on the night their erasure is carried out, not a
  year later.

  A granted erasure request brings every purge that reads it forward for one
  person, and the service-data purge is the job that marks the request executed
  and closes it. The chat purge was scheduled after that job, so by the time it
  ran the request was closed and it no longer selected the person: their messages
  stayed until each one's own year ran out, while the request recorded the erasure
  as carried out. The chat purge now runs before the service-data purge, like
  every other purge that reads the request, and the order is enforced for any
  purge added later.

- ca89fbc: Show a struck chat message's text to a moderator only while they hold a board
  seat, as the report queue already requires (ADR 0012). Its author still sees
  it.
- ca89fbc: Accept a connected app's token only while the member's consent to that app
  stands, and only under a consent that is no newer than the token, so a token
  minted around a disconnect is refused and stays refused when the member
  reconnects the app. Disconnecting a connection that does not exist answers 404
  and writes no audit entry, but still revokes any token the app was left with.

  Name an app that registered itself by its metadata document by the host of its
  client id, on the connected-app screens, in the audit log, in the record of
  processing and in the access report, instead of "unknown host". One helper now
  names a connected app's host everywhere.

- f2f3f87: A connected app's consent is withdrawn again when the audit entry recording it
  cannot be written, so no grant stands without its entry. The member is told the
  connection failed and can connect again.
- a1eaf25: A connected app is shown as dormant once the member's standing has narrowed.

  An external program a member connected can never do more than that member may do
  at the moment it asks, and Open BRF decides that afresh on every call. So a board
  term ending, or a member moving out, narrows every app they connected the same
  night it narrows them - nothing has to be revoked, and nothing is.

  What that cost was a list which said "connected" about a connection that could
  no longer reach anything, and said it more confidently the longer it stood,
  because the column showing recent activity is filled in by the app refreshing its
  own access on schedule. Both the member's own list and the board's now mark such
  a connection as dormant, with a sentence saying why, so that reading the list is
  enough to know which connections are still worth anything.

  Disconnecting is unchanged: it is still the member's own act, or the board's, and
  still takes effect on the app's next call.

- dbc309d: Keep the board's note on a publication consent out of the audit log, which
  outlives every erasure. The entry now records only that a note was written. A
  note carrying a personal identity number is refused with the reason
  `personal-identity-number`, however it is written: soft hyphens, zero-width
  characters and fullwidth digits no longer hide one. A note sent with a
  withdrawal is refused rather than accepted and dropped. Consent notes in audit
  entries written before this change stay where they are.

  Every personal identity number check now also sees a number hidden with an
  invisible character (a byte order mark, a word joiner, a variation selector) or
  written in fullwidth digits, and a line break or tab inside free text is no
  longer removed before the check. A number written with spaces or a line break
  between its date and its last four digits (`811228 - 9874`, `811228 9874`) is
  found too, as the identity-number parser already read it. The note is stored as
  it was checked, with the invisible characters removed and fullwidth forms
  folded.

- da58cb6: Prepare one export of a person's own data (`POST /api/data-portability/mine`)
  at a time for each person.

  No more than three exports are prepared at once for the whole instance, but one
  person could ask for all three in the same instant and hold every slot, and
  everybody else's export was then refused as busy until those three finished. A
  second export asked for while the person's first is still being prepared is now
  refused with the same 429 and `export-busy` reason, takes nothing from their
  budget of three a minute, and leaves the other slots to everybody else.

  A request refused as busy was always told `Retry-After: 1`, even when the
  instance's budget of twelve exports a minute was spent too, so its retry was
  refused again with the real wait. It is now told the longer of the two. A second
  stays the shortest wait, rather than the thirty seconds the report's transaction
  may take at most: an export usually takes well under a second, and a retry that
  is refused again costs only the check.

- f408d9d: The data-subject request forms and the breach decision and notification forms no longer answer a refused field with "could not be saved just now": they name the field the server did not accept, and they no longer send a request without its date or ground, or a decision without its ground. The grounds are held to the lengths the server accepts. A breach that was closed or removed in the meantime, or a notification recorded before the decision, now says so instead of falling back to "could not be saved".
- dbc309d: Smaller data protection fixes:

  - A data subject request stays open all of its due day on the association's
    calendar, instead of turning overdue at 02:00 that day.
  - The people named when a breach is recorded each get the audit entry that puts
    the breach on their access report, as a person added later does.
  - A breach decision's delay reasons are scanned for a personal identity number,
    as an update's are.
  - An apartment binder title is scanned and stored after the same folding of
    invisible and lookalike characters, and a title that is empty after it is
    refused.
  - The person page promises an erasure only where the nightly jobs will carry it
    out, not for a sitting board member, a resident or a system-role holder.
  - A board member no longer sees "Take out" on an entry they filed for the board
    into their own apartment, which the take-out refused.
  - A file that a failed filing could not remove is logged, in the binder and the
    archive.

- d315c66: Correct three values in the data protection module that a board acts on or the
  association has to stand behind.

  The note above the breach register stated the art. 33(1) test with two
  negations. It was a literal rendering of the English "unless the breach is
  unlikely to result in a risk" and did mean that, but "om den inte sannolikt inte
  medför någon risk" is not a sentence anybody should have to read twice while
  deciding whether a statutory notification is owed on a 72-hour clock. It now
  states the test the way the refusal beside it already does, so the two agree:
  "om det inte är osannolikt att incidenten medför en risk för de registrerade".

  The record of processing activities named the authority "Lantmateriet" in
  English. That value is seeded into the persisted art. 30 record rather than only
  rendered, so the misspelling was written into a document the association
  produces on request. It is Lantmäteriet, as the register module has always
  spelled it.

  Correcting the string alone would have repaired nothing already written, because
  the seed refreshed only the fields it derives from the configuration and left
  the text it had authored where it was. It now refreshes every field it wrote, on
  the same condition as before: only while nobody has edited the row. That
  condition is what protects a board's own words, and it is set by any edit that
  changes something, so a row the board has touched still comes out of a seed
  exactly as the board left it.

  The erasure ground for an upheld objection said an objection "nothing
  overrides". GDPR art. 17(1)(c) turns on there being no overriding legitimate
  grounds _for the processing_, which is what the label now says in both
  languages. It is what an operator picks when recording why an erasure was
  granted, and it prints on the data subject access report, so a ground that does
  not match the article is a weak record of the decision.

- 3f7753e: Give the data subject access report, and the art. 20 portability export built
  from it, thirty seconds to assemble rather than five.

  The report is gathered in one transaction, so that it and the audit entry
  recording it commit together, and that transaction ran under the database
  client's default limit of five seconds. The report is a query or more per
  section, in a row, and grows with the person's history - every audit entry naming them, every
  letter to the board mailbox in full - so on a slow database a person who has
  lived in the association a long time could pass the limit, and the report then
  failed with a server error every time it was asked for. That is an access
  request the board cannot answer within the month the law gives it.

  The transaction only reads until the audit entry at its end, so the longer limit
  holds no row locks.

- 933e778: Record the two-month extension GDPR art. 12(3) allows on a data subject
  request. The board can extend an undecided request inside its first month, once,
  with the reason the person was told. The due date then moves to three months,
  the request reads as awaiting an answer rather than overdue, and the overview
  does not count it as late. A request that has run past its first month cannot be
  extended: a notice recorded then would back-date one the person was not given in
  time. The entry in the audit log names the request and the new due day and
  leaves the reason on the request, and the access report carries both.

  The date of an extension is set in the register face on the request and in the
  access report, with the reason left in the ordinary one. The access report
  labels it in the subject's language, like the rest of the document.

- 53f44cf: Seed the demo association only when asked for, and never over a real one.

  `db:seed` was held back by `NODE_ENV` alone, which defaults to development, so
  run from a checkout whose `DATABASE_URL` pointed at a real instance it renamed
  the association, added a hundred people and wrote member register entries that
  can never be deleted. It now needs `--demo-data` on the command line
  (`pnpm --filter @openbrf/api db:seed --demo-data`), and refuses a database that
  holds an association under another name, or any person or member register
  entry it did not write itself.

- db32272: Move every package, container image and pinned action to its current release.

  Better Auth 1.7.3 restores the 1.6 account schema, in which an account is
  identified by its provider and the provider's account id. The required `issuer`
  that 1.7.0 through 1.7.2 added is no longer written, so a migration drops the
  column: left in place as NOT NULL, it refuses every account the application
  creates. Nothing reads it, and every existing row holds the value derived from
  the credential provider.

  pnpm moves to 12. Under 12, installing the reference plugin under `fixtures/`
  with the workspace ignored still resolves that install against the workspace
  root and links none of the plugin's own dependencies. The plugin now carries a
  `pnpm-workspace.yaml` of its own, which makes its directory a workspace root,
  and the fixture build installs it with a plain `pnpm install`.

  adm-zip moves to 0.6.1 through an override, here and in the reference plugin,
  for GHSA-vwc7-r8mq-g2x9. `@module-federation/dts-plugin` pins 0.6.0, and no
  build here extracts a type archive with it.

  Prisma stays on 7.10.0. Its `latest` tag names a release candidate,
  8.0.0-rc.13, while the client and the adapter are at 7.10.0 and the three move
  as one.

- bc2085d: Check the triggers themselves before the migrations run, not only who holds
  TRIGGER.

  A role holding TRIGGER on a table can replace a trigger on it with one that
  does nothing, or add one of its own, without owning the table. The job schema
  install looked only for that grant, and the hardening script, like the manual
  `REVOKE` in `docs/deployment.md`, takes the grant away without a word, so a
  guard replaced before an upgrade went unnoticed. The install also looked after
  the owner's Prisma migrations had run, and a trigger planted by another role
  fires with the privileges of whoever writes its table, the owner during the
  migrations among them.

  - `scripts/check-triggers.mjs` compares every trigger on a table in `public`
    and `pgboss` with the ones the migrations and the job schema install create,
    word for word, and checks that the table's owner owns the function each one
    calls. It also refuses a TRIGGER grant to a role other than a table's owner,
    or to `PUBLIC`, on those tables or in the owner's default privileges.
  - The `migrate` service runs it before `prisma migrate deploy`, and the job
    schema install runs the same checks in place of its grant scan.

  **Upgrade note:** a deployment that runs only the bundled steps sees no change.
  One whose triggers were changed by hand, or that has a trigger of its own on an
  Open BRF table, stops before the migrations with the trigger's definition in
  the log. Put back the trigger the migration under `apps/api/prisma/migrations`
  creates, or drop one you do not recognise, as the schema owner, and deploy
  again.

- 933e778: Keep a consented subletting application whose period has not ended when a
  granted erasure request is carried out. It was erased with the member's other
  closed applications, taking the board's proof of consent away while the letting
  still ran. The request now stays open with the application counted as kept, and
  the first run after the period's last day erases it.
- dbc309d: Carry a granted erasure request to key orders, subletting applications, the chat
  and the board mailbox, and close it only once they are empty.

  The service-data purge closed a request as carried out while the person's closed
  key orders and subletting applications, their chat group memberships, read
  markers and reports, and the board mailbox threads linked to them still stood.
  Each of those purges now erases them on a granted request, and the service-data
  purge counts them before it closes the request. An open key order or subletting
  application is still with the board, so it is kept and the request stays open
  until it closes.

  The chat purge also takes a former resident out of every group each night,
  recorded as `CHAT_GROUP_MEMBER_REMOVED` with no actor. The board mailbox purge
  keeps a thread linked to a person under a legal hold or a restriction whatever
  address the register holds for them now.

- 9a5ef06: Test every job that carries out a granted erasure against everything that
  refuses one. Only the booking purge had been tested for this, and only with a
  board seat. A new integration spec runs the eight domain jobs and the
  service-data purge against seven cases: a legal hold, a restriction of
  processing, a residency or a board seat with no end, one ending tomorrow, and a
  system role. Each also gets a control run with no refusal. A domain added to the
  erasure registry later fails the spec until it has a fixture of its own. No
  behaviour changes.
- dbc309d: Start a granted erasure only where it will be carried out.

  A granted erasure request lifts the retention window and nothing else, and the
  service-data purge refuses it for somebody who sits on the board, holds a system
  role or still lives here. The bookings, chat, event sign-up, motion and news
  comment purges ran first and checked only for a legal hold and a restriction, so
  they could erase a sitting board member's rows before the service-data purge
  logged the request as blocked. All of them now ask the same five questions
  (hold, restriction, board seat, system role, residency), and a person refused
  stays on each purge's own retention window.

  Each of those purges, the board mailbox's and the service-data purge now also
  take the keys a move-in, a board election and a role grant take before they ask,
  so one of those committing while a purge runs is either seen by it or waits for
  it, instead of the purge erasing somebody who has just become a resident, a
  board member or an administrator again.

- ca89fbc: Leave every line of an error's message out of the stack frames that are
  logged, including a message line that begins with "at ", so an address in a
  message is never logged as a frame and never read as evidence of which plugin
  failed at boot. Only lines indented as a call frame are kept, so this holds even
  when the message no longer matches the head of the stack.
- df3bcf1: Keep å, ä, ö and every other non-ASCII letter in an encrypted field.

  Field encryption handed the value to CipherSweet as a string, which the library
  turns into bytes as latin1, while decryption read the bytes back as UTF-8. Any
  letter outside ASCII came back as U+FFFD: in an uploaded member list held
  between the import's steps, and in encrypted names and addresses such as an
  issue reporter's or a board mailbox correspondent's. Values are now encrypted
  as UTF-8, and the ciphertext records that in its authenticated associated data,
  so a value is never read in the wrong format: a value stored before this change
  is read as it always was, as latin1, and a new one as UTF-8, with no guessing
  from the bytes. Nothing has to be migrated, and the column format is unchanged, but a value
  written by this release cannot be read by an older one.
  An older value reads back as entered when it holds nothing above U+00FF, which
  covers the Swedish letters; a letter above that was cut to a single byte when
  it was stored and cannot be recovered. Blind indexes are computed as before, so
  existing search results do not move.

- 933e778: Store an archive document's title and binder the way they are scanned for a
  personal identity number: invisible characters removed and a line break a
  space. A title made only of invisible characters is now refused as empty.
- 933e778: Store the free text of a breach, a processing activity and a processor agreement
  the way it was checked. The scan for a personal identity number already folded
  the text; the row kept what was typed, so an invisible character stayed in it.
  The text is now folded once, before the scan and before the write, as a consent
  note already is.
- aa27060: Fix a batch of defects in bookings, meetings, motions, issues, actions and
  events, and on the board's charges and fees screens.

  Bookings:

  - A booking can no longer be cancelled once it has been used. A resident
    cancels until it begins and the board until it ends, so a cancelled booking
    no longer gives the week's allowance back. The screens offer Cancel only
    while it can succeed.
  - A claim made while the board changes or withdraws the resource is refused,
    instead of landing on the old slot grid next to the new one.
  - A guest-apartment stay can be a single night: choose the check-in night
    again.
  - The booking panel uses resources and apartments that arrive after a failed
    first read. A stay being chosen is dropped when the resource it was chosen
    on is no longer offered, instead of being booked on another.

  Meetings and motions:

  - Once a meeting has been held, its attendance lines and proxy
    authorisations can no longer be struck off. A meeting can no longer be
    recorded as held before its day.
  - Checking somebody in, or registering a proxy, at the moment the meeting is
    concluded can no longer slip past the conclusion.
  - A second assistant for one principal, and an assistant or proxy holder
    recorded for themselves, are refused with a reason instead of a server
    error.
  - Striking off a member or proxy holder also strikes off the assistant they
    brought, including one being checked in at the same moment, and when a
    person's member and proxy-holder lines are struck off at once.
  - A proxy holder registered as a member no longer votes for anybody after
    leaving the association. A proxy authorisation dated after today is
    refused.
  - Erasure and retention keep a motion while the meeting it is on has not
    been held, and the access report states no erasure date for it until then.
  - A failed re-read on the motions screen keeps what the screen showed.

  Issues, events and actions:

  - The photo limit on an issue holds against uploads sent at once, and a
    refused upload leaves no stored file behind.
  - Removing an issue type while somebody files a report, two edits to one
    event series at once, publishing a series while an edit or a removal writes
    it, and calling off or reinstating an occurrence while an edit removes it
    are answered with a reason instead of a server error. A series cannot be
    published with a personal identity number added by an edit made at the same
    moment.
  - An occurrence that has begun can no longer be called off.
  - Calling off an occurrence waits for a sign-up to it that is in flight, so no
    sign-up is taken on an occurrence that has already been called off.
  - The action catalogue leaves out plugin actions the caller would be refused.
    Looking one action up uses the same surface as the list, and a disabled
    plugin's action is answered as unknown.
  - A core action holding a capability that no action may hold, or a name or
    alias describing an act no action may perform, is refused when it is
    registered. A plugin's declaration was already refused by the gate.

  Charges, fees and other forms:

  - Amounts typed the Swedish way ("1 234,50") are accepted on the charges, fees
    and move screens.
  - The fee aid reads each participation share as a part of the recorded shares'
    sum, and never of less than one whole share, so shares recorded as
    percentages or whole numbers give the right fees.
  - Charges and fees are removed only after a confirmation, and a charge can be
    corrected on the charges screen. A saved correction is confirmed, a charge
    half typed survives opening one, and the correction closes when its charge
    leaves the list.
  - A VAT rate on a charge that is not a whole percentage is refused at the
    field, as on the fees screen, instead of being sent as no rate.
  - A failed read of the charge parties is reported on its own. Clearing a date
    no longer reads as a failed load, or leaves the screen saying it is reading,
    and the fees screen states a refused register date instead of offering a
    retry.
  - An accounting basis produced for dates the board has since changed is no
    longer shown.
  - One fee-notice document is produced at a time. It states its period,
    production date and due date, prints, and labels the bankgiro and the
    plusgiro.
  - A withdrawn sublet application or key order says the member withdrew it,
    not that the board answered it.

- 53f44cf: Judge a ten-digit personal identity number's century by the whole birth date,
  store it with that century, and reindex the people already stored.

  A number written without its century takes the most recent birth date that is
  not in the future. Only the year was compared, so in March 2026 `261201-1235`
  was read as 1 December 2026, a date still to come, and a search for
  `192612011235` did not find the person. The date is now compared whole, with a
  coordination number's day taken without its offset of 60. A plus separator is
  still read as the year the person turns 100.

  Even read by the whole date, the same ten digits name another person once the
  day they are read on passes the birthday they carry: `261201-1235` is 1926 until
  1 December 2026 and 2026 from then on. So a number is now stored with the
  century it was read with (`19261201-1235`), and one whose reading would differ
  a year earlier or a year later is refused, by the person form and by the
  import, until it is written with its century. A number accepted on two dates
  less than a year apart is read as the same person on both, and an import whose
  rows would now be read differently from its preview is refused as outdated
  rather than applied.

  Each person now records the normalisation rules their blind indexes were
  computed under. After the upgrade the instance recomputes the indexes of every
  person stored before it, from the encrypted values, in a job queued at start,
  and writes the century into each stored personal identity number that lacks
  one: the century it was written with, not the one it reads as on the day of
  the upgrade. A number is taken as written when the person was added, unless
  the index stored beside it shows it was added later; a later change to the
  person, such as marking them protected, does not move it. Until the job has
  finished, a search by phone number or personal identity number can miss a
  person stored before the upgrade.

  A few stored numbers cannot be settled from the record: a number whose
  birthday falls between the day it could first have been written and the
  person's last change, such as `261201-1235` for a person added in March 2026
  and changed in December, could be either century. The job reads such a number
  as written when the person was added, or, when its index shows it came later,
  keeps the century that index carries, and logs a warning naming the person.
  Look for warnings from `PersonReindexService` after the upgrade, and check the
  century of those people's numbers with them.

- 1898cd6: Find a personal identity number written with any dash.

  The scan that keeps an identity number off a page, a news item, a motion or a
  subletting application took the hyphen and a list of look-alike dashes as the
  sign before the last four digits. A number written with a dash missing from the
  list, such as the horizontal bar (`811228―9874`), the two-em dash or the
  Armenian hyphen, went through. NFKC does not fold those. The scan now takes
  every character Unicode classes as a dash, plus the minus sign, and still runs
  in linear time. The parser for a stored number is unchanged.

  The import's check for number-shaped values now uses the same Unicode rules.
  It used to read `\p{…}` as literal letters, so a value such as `811228p9874`
  counted as number-shaped, and a value split by a non-breaking space did not.

- a2b2ec0: Close two gaps left by the subletting follow-up.

  The personal identity number scan now reads the characters that look like the minus
  between the date and the last four as that sign: the modifier letter minus, the
  hyphen bullet, the heavy minus sign, the box drawings horizontals and the
  horizontal line extension. The scan did not recognize these look-alike signs, so
  a number written with one passed it. The parser for stored values is unchanged.

  Recording the end of a subletting answers "no such application" when the nightly
  purge deleted the application between the read and the write, instead of 500.

- ca1b7e5: When a row of a member list import could be more than one person, the preview
  now says which of them already has a residency on the apartment that overlaps
  the row's in another role or for other dates. Choosing that person writes
  nothing for the row and counts it as a problem, and the screen now says so
  beside the choice instead of only in the result after the import.
- dffcafc: Let the board decide an import row that contradicts the person it matched.

  A row matched through an email address, or through the apartment and a name,
  now waits for a decision when its personal identity number differs from the
  matched person's, and an email match also waits when the name differs. The
  preview says which of the two differs and offers the person as a choice, as it
  does for a row that matches more than one person.

  An import no longer adds a personal identity number to a person it matched
  through an email address or a name. Such a match still fills in the other
  fields the register does not have. A later row of the file with the same
  identity number, such as a member's second apartment, is written to that same
  person without adding the number, however far down the file it is, rather than
  creating them a second time.

  The persons earlier rows of the same file create or fill in are held to the
  same rules. A row with the email address of an earlier row but another name or
  identity number waits for a decision instead of being folded into that row's
  person, and the preview now finds such a row however far down the file it is,
  so an import no longer stops partway through a long file at a row the preview
  showed as an update.

  The preview names the person each matched row will be written to, and says
  when a row's personal identity number will not be added to that person,
  including the person the board chooses for a row.

- d676138: Hold a choice the board made for an import row to the persons it chose
  between. A row the board gave to a person it chose is now also checked against
  the register inside the transaction that writes it, as a row it made a new
  person already was, so somebody who joins the row's candidates while the
  import waits for its locks stops it instead of being passed over. The check
  also stops the import when one of the candidates leaves - moves out or is
  erased - after the chunk was planned, and the chunk holds the candidates'
  transition locks while it checks, so a move-out cannot slip in between. A row
  the board decided to leave out no longer stops the import when its candidates
  change, since it writes nothing whoever it matches. The message for an import
  stopped this way now says so, rather than only that a person would have been
  entered twice.
- ca1b7e5: Starting a member list import after answering rows the preview could not
  resolve no longer works out the whole file again inside the request. For a long
  file with personal identity numbers, checked against a register that already
  holds some, that took minutes and could outlast the proxy in front of the API.

  The import now starts only with the answers its preview was worked out with,
  and is refused with `decisions-not-previewed` otherwise. The import screen then
  takes the preview again with the answers, in the background as any preview,
  and starts the import as soon as it is ready if it shows the same rows. When
  the answers change what other rows match, the screen shows the new preview
  first, as before.

  The preview now also records where it writes every row, and each part of the
  import checks its rows against that before it writes them. A row that a change
  elsewhere in the register has sent to another person since the preview - an
  email address moved from one person to another in the address book, say - stops
  the import with `register-changed-during-apply` instead of giving that other
  person the row's residency and member register entry. The parts written before
  it stay written. A row the board chose to leave out does not stop the import
  this way while it still needs an answer, since nothing is written for it. A
  preview taken before this version is refused with
  `preview-outdated`, and taking it again is enough.

- ca1b7e5: The member list import refuses a mapping that maps a role or move-in date
  column and also gives a role or move-in date for the whole file. The value for
  the whole file is for a file without that column, and the screen only offers it
  then. Through the API, a blank cell used to get it, and a row without a date
  could then be counted as a residency already recorded or refused as a conflict
  depending on the order of the rows.
- 3d9c267: Close the last gap in the import's check for a person entered twice. Adding a
  person from the address book with a personal identity number now takes a lock
  on that number, and an import chunk takes the same lock for every number it
  writes before it checks the register again. A person added with a row's number
  while the chunk runs is either seen by the check, which stops the import, or
  added after the chunk commits. The lock is keyed by the number's blind index,
  so the number itself never reaches the database's lock table.
- 39d961e: Tell the board how to fix a CSV that mixes encodings.

  A CSV without a byte order mark that is UTF-8 apart from a stray byte is
  refused, but the board saw only "That file could not be read as a spreadsheet.",
  which does not say what to do. The refusal now has its own reason,
  `file-mixed-encoding`, and the import screen says to save the file again as
  UTF-8 or as "CSV (semikolonavgränsad)" and upload it again.

- 26c5236: The member list import writes each person once, and reads a file within fixed
  limits.

  - Only one import is written to the register at a time, and every part of an
    import is planned again under its locks before it is written.
    Coming back to the import screen shows the import that is still running
    rather than a newer one that has finished.
  - The preview is worked out in the background, and the screen shows how far it
    has got. A long file with personal identity numbers, checked against a
    register that already holds some, no longer keeps a request open for
    minutes. That includes the preview taken again with the board's decisions. A
    preview the screen stops waiting for - another file is chosen, or
    the page is left - is stopped at once, and one the screen stops asking about
    is stopped after two minutes, so neither holds up the next one.
  - The apply runs only the preview the screen was shown. If the upload has been
    previewed again since - in another tab, or by another board member - the apply
    is refused and the screen goes back to the column mapping.
  - A row for someone who already lives in the apartment in another role, or for
    other dates, is reported as a problem with the row instead of being dropped
    without a word. Someone who moved out and back in gets their second period.
  - A row that states its own move-in date is matched by apartment and name to
    someone whose residency there has ended, instead of creating them again.
  - An uploaded file is refused while it is being read once it passes 5000 rows,
    200 columns or 1000 characters in a cell, and a workbook once it unpacks to
    more than an import reads or names a cell it cannot place. Cells that are
    only formatted, below or beside the list, do not count. A quotation mark that
    is never closed is refused instead of turning the rest of the file into one
    cell.

- 35b3f73: Tell the board why the import screen refused a file or a mapping.

  A member list over the size limit was answered `invalid-body` by the upload's
  request schema before the service could refuse it as `file-too-large`, so the
  screen said only that the import did not work just now. The upload is now
  refused as `file-too-large`, and the screen names the limit. A file of about
  750 KiB or more never reaches that check: the server's request body limit
  answers 413 first, and the screen now reads a 413 on upload as the same
  refusal.

  A mapping the API refuses now carries the problems it found, as codes, in a
  `problems` field next to `mapping-invalid`, and the screen lists a sentence for
  each of them under the general message instead of dropping them. The catalogs
  gain the two problems they had no sentence for: a default role or move-in date
  chosen while the file has the column.

- f756e48: Stop an import instead of entering a person twice. A row that writes a new
  person - planned as one, decided as one by the board, or giving a person that
  an earlier row creates an email address or a residency - is checked against the
  register again inside the transaction that writes it. If the recheck
  finds somebody the plan did not have as a candidate, under a key the plan
  searched (email address, personal identity number, or name and apartment), the
  import stops without writing that part of the file, and the screen asks the
  board to import the rest as a new file so the preview shows the match. The
  email and name-and-apartment checks stay protected by their locks through
  commit; the personal identity number check has no such lock, so a match added
  after that lookup can still be missed. A row the board answered is also
  checked, chunk by chunk, against the persons the preview showed for it, so
  somebody added while a long import runs stops it rather than being passed over.
  Matching a row to a person on its apartment now counts a move-out dated today
  as having happened, on the association's calendar, as the board's screens do.
- dffcafc: Check the board's decisions on an import before it starts writing.

  A decision on an ambiguous row writes something the preview could not know:
  the person chosen for the row gets its email address, and a new person gets
  the row's details. A later row that contradicted that person used to be found
  only while the import ran, and the import then stopped with part of the file
  already in the register.

  Starting an import now plans the whole file again with the decisions, and
  refuses before anything is written if a further row needs a decision, or if
  any row would be written differently from the preview: a row the preview asked
  about that no longer needs a decision or now matches other people, or a row
  shown as an update that would now create a person. That holds when every
  decision is to skip a row too, since skipping can undo what the preview was
  planned with. A decision for a row that needs none is refused the same way,
  and a decision must name a row by its number, at most one per row a file can
  hold. The import screen then previews the file again with the decisions made
  so far, keeps those that still apply, and shows the rows that now need one.

  A row the board decides never adds a personal identity number to a person
  already in the register, even when the register changes while the import
  runs.

  An import previewed again elsewhere while it was being started is refused
  rather than started with the other preview's mapping, and the screen says so
  instead of previewing over the other preview. An import started while another
  one is running is refused as such before its decisions are checked.

  The preview also names the person a row is folded into when an earlier row of
  the file creates them.

- 2ef5246: Stop an import rather than write a row the board decided to skip, or to make a
  new person, to the person it matches after the register changed.

  An import of a long file is written in chunks, and the register can change
  while it runs. When a row that waited for a decision no longer needs one by the
  time its chunk is written, because a name was corrected or one of the people it
  matched was removed, the import used to drop the board's decision and write the
  row to the one person it then matched: a row the board chose to skip, or to
  make a new person, became an update of that person, with a residency and
  possibly a member register entry, which cannot be removed. The import now
  stops at that chunk, records it as "register-changed-during-apply" and writes
  nothing from that chunk. The screen then says the register changed while the
  import ran, either because a row now matches somebody added or changed during
  the import or because a choice made for a row no longer fits the register, and
  asks the board to import the rest as a new file: the session cannot be
  previewed again, and the new file's preview shows what each row matches at
  that time. This differs from a request that arrives with decisions the preview does not need,
  which is still refused at once as "preview-outdated" ("Your choices change what
  other rows match. Preview the import again.") before anything is written.

- ed7a2e8: Keep an import from entering a person a second time while the reindex at boot
  rewrites personal identity numbers.

  After an upgrade that changes how numbers are normalised, the reindex at boot
  moves each person's number to the index the new rules compute. Until it has
  reached a person, a lookup by their number misses them. An import applying in
  that window could enter a row with that number as a new person, and the
  reindex would then give the person it had missed the same number. The register
  held two persons for one human being.

  An import chunk that writes personal identity numbers now checks whether any
  number is still waiting for the reindex. While one is, the chunk rolls back and
  the apply is queued again for half a minute later. The wait does not spend the
  retries meant for a lost database connection, so a long reindex no longer ends
  the import as interrupted. One job per import waits at a time: the job a
  restart queues, or a job delivered twice, leaves the wait to the one already
  queued. The session records when the wait began, and an import that has waited
  an hour stops as interrupted, and the log says it was waiting for the reindex.

  The reindex also takes the identity number lock for the index a number leaves
  and the one it gets, as every other writer of a number does. It waits up to
  three minutes for that lock, longer than an import chunk holds it. One run at a
  time walks the register, whichever instance it is on: it holds a lock of its
  own on a database session, so the runtime role's connection limit is one
  higher. A run that does not finish is queued again a minute later rather than
  left until the next restart, for up to an hour of runs that write nothing. It
  gives up at once on a value it cannot decrypt, and on giving up the log says
  what to check and to restart the instance.

- df3bcf1: Read a member list saved by Swedish Excel without losing å, ä and ö.

  Excel on Swedish Windows saves "CSV (semikolonavgränsad)" in Windows-1252, and
  the import read every CSV as UTF-8, so each Swedish letter became U+FFFD and
  the damaged names were written into the member register. The import now
  decodes a CSV as strict UTF-8 and falls back to Windows-1252 when the bytes are
  not UTF-8. A file with a UTF-8 byte order mark is always read as UTF-8, so a
  single stray byte in it costs one letter rather than turning the whole file
  into mojibake. A file without one that is UTF-8 apart from a stray byte is
  refused as unreadable, rather than read as Windows-1252 and imported as
  mojibake such as "Ã…sa"; saving it again as UTF-8 or as Excel's
  "CSV (semikolonavgränsad)" fixes it.

  A value that still holds U+FFFD, because the file lost the letter before it got
  here, is now a problem on its row in the preview: the row is not imported, and
  the board sees why before applying.

- ca1b7e5: An Excel member list with formulas is no longer refused as too long because of
  the calculation chain, or because of the values Excel keeps from another
  workbook a formula refers to. The import never reads those parts, so they are
  now left out instead of checked.
- 15a0a46: Activating an invitation now refuses a password longer than the 128 characters sign-in accepts. Before, a longer one created an account that could never sign in. The activation form stops at the shared limits, and creating an account for a person checks them itself, so no other route to it can repeat the mistake.
- 0b99835: Keep the reporter of a public-form issue report when a legal hold or a
  restriction of processing (GDPR art. 18) stands against the person whose
  address is on it.

  The public-form issue purge detached the reporter's name and address from
  every report closed more than a year ago without asking whether that address
  matches the registered address of a person under a legal hold or a restriction.
  Like the charge, fee, key order, sublet application and board mailbox purges,
  it now leaves those reports alone: it matches each withheld person's registered
  address against the report, as the board mailbox purge does, and reads the hold
  and the restriction again under the legal hold registry lock before it detaches
  anything, so a hold placed or a restriction granted while the purge is running
  is honoured.
  Releasing the hold or lifting the restriction lets the next run detach them.

- a41bd1c: The issue report's place and description limits (200 and 4000 characters) are
  now one definition in `@openbrf/shared`, used by both the API and the report
  form, so the form and the server cannot drift apart.
- 5e7c883: Finish the job queue's index builds at deploy, and stop the deploy when one
  fails.

  A pg-boss upgrade that adds an index to job tables that already exist does not
  build it during the migration: it records the build in `pgboss.bam` for a
  background runner that only an instance with pg-boss migration enabled runs.
  The application runs with migration disabled in production, and the job schema
  installer stopped pg-boss straight after starting it, which left the runner
  time for one build at most. So on an upgraded instance a build could stay
  pending with nothing to finish it, and a failed one still let the deploy go
  on. The installer now waits until every queued build has finished, and exits
  non-zero when one fails, with the error kept in `pgboss.bam`. The next deploy
  retries it, and also finishes any build an earlier deploy left behind. A fresh
  install builds its indexes inline and does not wait.

- 53f44cf: Harden the job queue schema install that the `migrate` service runs as the
  schema owner. The application's database role can no longer write pg-boss's
  queue of index builds, only read it. Before installing, the install now stops
  on a queue that is partitioned or names a job table of its own, which Open BRF
  never declares. It also removes index builds that have not run yet while a role
  other than the owner can still write that queue.
- ca89fbc: Count only administrators who can sign in when refusing to remove the last
  one. A grant on a person with no account no longer lets the last
  administrator who can sign in revoke their own grant.
- 094f814: Harden sign-in, connected apps and the register after the access-control
  review:

  - One rule decides where an authorization code may be sent, shared by client
    registration and the consent screen: https off this machine, plain http on a
    loopback host, or an app's own reverse-domain scheme. A client that
    identifies itself by its metadata document must keep its web redirect
    addresses on that document's origin, and every address in the document
    must meet the shared rule. No name under `localhost` is taken for https.
  - The consent screen names the app when the code goes to an app's own scheme,
    and says that any app on the device can claim that name.
  - A connected app's token carries only the scopes the member's consent grants
    now.
  - In production, a `BETTER_AUTH_SECRET` committed to the repository or with
    fewer than 8 different characters stops the instance from starting, even
    when it is 32 characters long. Replace such a secret before updating, as the
    upgrade note on the 32-character rule describes.
  - A change sent with the session cookie in a body an HTML form can send
    (URL-encoded, multipart or plain text) is refused when it carries neither
    `Origin` nor `Sec-Fetch-Site`.
  - An invitation to an address another account already signs in with is
    refused with its own message instead of failing at activation.
  - An election may be dated at most five years back, also in a board
    recovery.
  - A failure's logged stack keeps only lines shaped like call frames.
  - Putting somebody into a group chat they are already in answers with the
    member list, whoever they are.
  - The confirmation of an account request says that a later request from an address with one
    waiting is not kept.

- ca89fbc: Answer a magic-link sign-in request before the account is looked up or any
  mail is sent, so the answer is the same, and as fast, for every address. A
  delivery that fails is logged by its class and no longer turns the answer into
  a server error.
- 9a5ef06: Read which rows of the record of processing activities name the mail server
  from the mail templates themselves. Each template now declares the processing it
  is sent under, and the seed collects those rows instead of keeping its own list.
  The breach reminder and the reporting obligation notice had been missing from
  that list. A unit spec walks the source for every mail template and fails for
  one the seed does not reach, or one that declares no processing without being
  named as sent on none. The plugin message is the only one so named. The record
  itself says the same as before.
- 9a5ef06: Count a board mailbox thread as kept, rather than owed, when a granted erasure
  reaches it and its address belongs to somebody under a legal hold or a
  restriction. This happens when an address changes hands or a household shares
  one. The purge already kept the thread, but the request's scan picked it ahead
  of the nightly bound every night and the purge refused it every night. The open
  request said the job had not got through yet, and kept saying so for as long as
  the hold stood. The scan now leaves such a thread out. The request stays open
  and names the thread as kept because of the hold.
- 933e778: Write an uploaded file's row and the audit entry that records it in one
  transaction. An entry that could not be written used to leave the row and the
  stored file behind, outside the rollback of the caller that uploaded it; the
  upload now fails as a whole and removes the stored file.
- 2bf7072: Leave no file behind when an upload cannot be written to the audit log. The file's
  row and its audit entry are now written together, and the stored object is removed
  if either fails.
- 5df2086: Make a meeting's children refuse its delete instead of following it.

  The agenda, the attendance lines, the proxy authorisations and the notice all
  cascaded from the meeting. Nothing in the platform deletes a meeting - no
  endpoint offers it and the motions link has restricted since the motions
  migration - so the guarantee held in practice, but it was a sentence in a
  comment rather than something the database would enforce. One `DELETE` would
  have taken the running order the members were summoned to deal with, the list
  the votes were counted from, the authorisations behind those votes and the
  document that summoned them, and left nothing behind saying the meeting had been
  held.

  The four foreign keys now restrict, so the delete is refused for as long as any
  child stands. The two cascades inside the module that are load-bearing are kept
  and now say why they are: a decision and a vote still go with the agenda item
  they were recorded against, because replacing an agenda while the meeting is
  being arranged is a real flow that deletes and rewrites the items, and a
  notice's delivery ledger still goes with the notice.

- ecb5f2b: Write the member register's ENTRY and EXIT rows by the dates of a person's
  moves, not by the order the moves are entered in.

  Whether a move began or ended a membership was decided by counting the
  person's other tenant-ownerships that had not ended by its date, including
  ones that had not begun by then either. So a back-dated move-in entered after
  a later one wrote no ENTRY and dated the membership from the later one; two
  move-outs entered against their date order each saw the other apartment as
  still held and neither wrote the EXIT, leaving the person a member for ever;
  and leaving one apartment before taking over one bought for later wrote no
  EXIT for the months in between. An import had the same fault, and the
  register it left depended on which of a person's apartments the file listed
  first.

  Moves and the import now share one rule. A tenant-ownership counts only on the
  days it is held, a membership ends on the latest move-out once none is held,
  and the rows a change writes are the ones that make the register read, day by
  day, as the person's residencies do. An import settles each person once per
  chunk of rows, so a file lists a person's apartments in whatever order it
  likes. Rows already in the register are not changed.

- 2bf7072: Say when a move-out's membership begins again on an apartment bought for later.

  When a member moves out of their only apartment while one they have bought has
  not been taken over yet, the member register records the gap: the membership
  ends on the move-out date and begins again on the later move-in date. The
  move-out answer now carries that date as `memberRegisterEntryOn`, and the
  move-out panel says the membership begins again then, rather than only that it
  was closed.

- 4ff70df: Fix a set of defects in news, chat, the contact form and mail delivery.

  - A news item taken down before its mailing went out, and then put back up,
    now sends the mailing. Before, the members were never mailed and the board's
    screen showed the mailing as pending for good.
  - Saving and publishing a news item check for a personal identity number, and
    refuse to rename a mailed item, on the item as it stands at that moment, so
    a publish or a draft save landing in between cannot slip past either check.
    Two items given the same address at once answer "address taken" rather than
    a server error.
  - `news_list` keeps paging past an item removed since the last call. Its
    cursor has a new form: a cursor issued before this release answers
    `not-found`, so start the list again without a cursor.
  - The board's news list counts each mailing in the database instead of
    reading every delivery row.
  - The board is told about contact form messages through jobs that retry over
    about half an hour and are logged when they give up. Across the instance, the
    board is mailed about at most ten contact messages an hour; messages past
    that are stored and shown in the inbox as always.
  - The contact inbox is read a page at a time and says how many messages are
    waiting, so a burst of messages no longer hides the ones after it. Several
    messages can be selected and deleted together. Handling or deleting a
    message another board member just deleted says so rather than failing.
  - `GET /api/contact-submissions` changes shape: it answers one page,
    `{ submissions, unhandled, total, nextCursor }`, instead of an array of every
    message, and takes the `cursor` it answered to read the next page. The web
    app that ships with this release reads the new shape, and the new
    `POST /api/contact-submissions/remove` deletes up to 200 messages at once.
    The endpoint belongs to the board's own screen rather than to the management
    API, and nothing an operator runs has to change, so this is a patch.
  - Chat write limits (messages, groups) and the news comment limit hold under
    many requests sent at once. A report sent while the board strikes the
    message through is refused. A chat message written in the same millisecond
    as another is no longer missed by an open chat screen. A group's name may
    not carry a personal identity number, and a group's member list no longer
    shows people who have moved out.
  - With no mail configured, an instance outside production no longer prints
    messages, sign-in links included, to its log. A developer who wants that
    sets `OPENBRF_MAIL_LOG_BODY=true`. Dates such as a move-in day are written
    in mail as the day they are. A message reads the association's settings once
    rather than twice, and the stored SMTP password is decrypted once rather than
    for every message.

- 241d9db: A news save and a publish of the same item at the same moment could each act on what the item was before the other one landed. A save could write a personal identity number into an item that had just been published, a publish could make readable a personal identity number a save had just written, and a save could rename an item whose address had just been mailed to the members. Both now lock the item's row and check it as it stands before writing.
- 241d9db: Two board members editing the same news item could overwrite each other: the
  later save silently replaced the earlier one's text. A news item now carries a
  revision, as a page does. The editor sends the revision it opened, and a save
  built on a copy somebody else has saved over is refused with `news-changed`
  (409). The board is told that somebody else saved first, the list shows their
  version, what was typed stays in the form, and saving again writes it over
  theirs. Save stays off until their version has been read. If that read fails,
  the editor says so and offers to read again; if the item was removed meanwhile,
  what was typed stays as a new draft.

  `PUT /api/news/:id` takes `expectedRevision` as optional, so older clients keep
  working. The `news_update` action takes it as optional too, since the action was
  armed before the field existed; a connected app that sends the revision it read
  gets the same refusal. The migration adds
  `news.revision` with a default of 1.

- 4ddfe44: Keep a news item's comments out of its removal.

  A comment is its author's personal data, and the news comment purge is now the
  only thing that erases one. That purge honours legal holds, restrictions and
  erasure requests, and writes an audit entry for each person. Removing a news
  item that residents have commented on is refused with the reason
  `has-comments`, both on the board's screen and through the `news_delete`
  action. The board can take the item down instead, and remove it once the
  comments have been purged. A migration changes the comment's foreign key to
  the news item from `CASCADE` to `RESTRICT`, so the database refuses such a
  delete as well.

- f2f3f87: Add `OPENBRF_OAUTH_CLIENT_METADATA_HOSTS`, an optional list of the hosts a
  connected app may identify itself from by its metadata document. Empty, the
  default, any public https host may, as before.
- f2f3f87: A client registered by hand is removed again when linking it to the resource or
  recording its registration fails, so a failed registration leaves no live client
  without an audit entry behind, and a retry does not create a second one.
- f89b126: Register an OAuth client only through the administrator's route.

  The sign-in library's own client-management endpoints accepted any signed-in
  account. A resident could register a client under any name and host, the
  association's own included, send its authorization codes to an address of their
  choosing, and change either later. A member who consented to that client on the
  consent screen gave its registrant a token acting as them. Those endpoints now
  answer 404, and the library refuses every client action to anybody without
  `association:manage`, however it is called. A client is registered by hand
  through `POST /api/oauth-clients`, which requires `association:manage` and
  records the registration in the audit log.

  That route answered 500 for an administrator, because it called the library
  without the administrator's session. It now registers the client, links it to
  the resource and records it.

  The authorization server no longer offers the `client_credentials` grant, so
  every token it issues acts for a person who consented to it.

- f2f3f87: An administrator can turn a connected app away for the whole instance with
  `DELETE /api/oauth-clients/<client id>`, which needs `association:manage`. Every
  member's connection to it is cut at once, its tokens stop working, its client
  id is refused at authorization from then on, and the audit log records it as
  `OAUTH_CLIENT_REVOKED`, with a `CONNECTED_APP_DISCONNECTED` entry against each
  member whose connection it cut, so their own data subject access report shows
  it. A client the instance does not know answers 404 with the reason
  `client-not-found`.
- ca89fbc: Accept only https redirect URIs for a hand-registered connected app, or plain
  http on a loopback host for an app on the member's own machine, with no
  credentials or fragment in them. The consent screen sends the browser back to
  an app only at a web address. An app on the member's own machine is registered
  with the provider as a native app, which is the only kind it accepts a loopback
  address for; that changes only how the addresses are checked, and the member is
  still asked before the app can act. An address the provider itself refuses,
  such as an https address on this machine, now answers 400 with the reason the
  registration form has a sentence for, where it used to answer 500.
- be66b1f: Run one member list import at a time.

  Applying an import is now refused with `another-import-running` (409) while
  another import session is queued or applying. The upload asked about stays in
  the mapping step with its preview, so it can be applied once the other import
  has finished. Two imports running side by side would each plan against a
  register the other was writing, and a person listed in both files could be
  created twice with a member register entry each, which can only be answered
  with a correction entry.

  The check and the claim run in one transaction behind an advisory lock, so two
  imports of two different files applied at the same moment cannot both start.

  The import screen shows the refusal in the interface's own words and keeps the
  preview on screen.

- 3693e97: Keep one connected-app consent per member and app. Two consents submitted at
  the same moment could leave two rows granting different things; a unique index
  now refuses the second. The migration first merges any duplicates already
  stored into the earliest row, keeping only what every one of them granted, so
  an app may ask an affected member to consent again. Until that migration has
  run, a token carries only the scopes every one of the member's consents for
  the app grants.
- 30456a5: Tighten the outbound-connection hardening. The address rule now also refuses the
  IPv4-translated IPv6 range (`::ffff:0:0:0/96`) and the deprecated site-local
  range (`fec0::/10`), and saving the SMS gateway address with a user name or
  password is refused in the settings service as well as at the route, so such a
  credential never reaches the stored column.
  The SMS settings screen explains that refusal in the board's language.
- a288424: Ask for a fresh preview when another import has written to the register since.

  Applying an import is now refused with `preview-outdated` (400) when another
  import wrote to the register after this one was previewed. The preview was taken
  against a register that has changed: its counts may no longer hold, and a row
  it matched to one person can match two now. Such a row used to stop the import
  on its first chunk with `ambiguous-rows-undecided`, and the session it left
  FAILED could not be previewed again, so the file had to be uploaded again. The
  refusal comes before anything is claimed, so the upload stays in the mapping
  step and previewing it again makes it applicable. An import that wrote nothing,
  because it stopped first or because every row was skipped or in error, does not
  count.

  What tells the two apart is a count of import chunks that wrote, kept in a new
  single-row table, `import_revision`. A chunk advances it in the same
  transaction as its writes, and a preview records it on the session
  (`previewedRevision`) before it reads the register. It does not depend on
  clocks, or on the other session still being there after the daily purge. A
  session previewed before this migration has no count recorded and is previewed
  again before it applies.

  The import screen already takes the preview again when an apply is refused as
  outdated; its notice now names another import as a possible cause, in Swedish
  and English.

- 53f44cf: The application itself now refuses a production start with `OWNER_DB_PASSWORD`,
  `POSTGRES_PASSWORD`, or a `DATABASE_URL` beside the runtime connection in its
  environment, as the image's entrypoint already did. A platform that starts the
  server without that entrypoint is held to the same rule.
- 6011cfb: A protection change on a person that got no answer (offline, a timeout) is now read back, so the panel shows what the register holds instead of an unmasked person who may already be protected. A lien release that got no answer or a server error is read back too, and reported as recorded when the register shows it, rather than as a refusal that sends the board to release again; when the register cannot be read either, it is reported as not known, with a retry of the read. A protection change whose read-back fails too leaves a notice and a retry on the panel. A chat room that cannot be read now says the chat could not be read, not that something could not be saved. Liens in the apartment register extract are listed in a fixed order when two share a day, so "entry n of m" names the same row after every read.
- 91ebd38: A plugin or theme change answers `package-lock-lost` only when its database
  session is known to have ended.

  When the wait for a plugin or theme id's lock failed with an error that does
  not say whether the session ended, the session was asked a question to find
  out, and any trouble with that question was taken for a lost session. A
  session that was only slow to answer, a question that was cancelled, or an
  answer that could not be read turned a failure the change could recover from
  into a 503 with the reason `package-lock-lost`. Such a change now fails with
  the error its wait met. A session that is confirmed gone, because the
  connection dropped or the server ended it, is still answered 503 with the
  reason `package-lock-lost`.

- f408d9d: Changing a password to one longer than the 128 characters signing in accepts now says the new password is too long, where before it said the current password did not match. The password forms stop at 128 characters, and first-boot setup refuses a longer administrator password instead of storing one that could never sign in. The limit is shared as `MAX_PASSWORD_LENGTH` in `@openbrf/shared` and set on the sign-in library.
- 53f44cf: Read `+46 (0)70 123 45 67` as the same phone number as `070-123 45 67`.

  The common spelling that keeps the trunk zero in brackets beside the country
  code, with `+46` or `0046`, normalised to `+460701234567`, so register search
  and the import's duplicate check did not match it with the same number written
  any other way, and a text message went to a number that does not exist. The
  zero after `+46` is now dropped. People stored before the upgrade are
  reindexed by the same job at start as the personal identity number change.

- 27ab621: Give up on plugin tarball downloads that take too long.

  A release host that sent its headers and then stopped sending held the plugin
  install job, or the reinstall at boot (`OPENBRF_PLUGINS_REINSTALL_ON_BOOT`),
  indefinitely, and every later install waited behind it. One download is now
  abandoned after five minutes, redirects and body included, and all of a run's
  downloads together after eight. The first download that fails ends the
  fetching: that plugin is marked as failed with the reason, the plugins not yet
  fetched keep their status, the installed plugins are left as they were, and
  the next run tries again. The catalog index and theme packages already had a
  deadline of 30 seconds.

  The plugin install job now allows itself 30 minutes before the queue gives up
  on it, rather than the queue's default 15, so a run that waited for another run
  and then downloaded and installed is not started a second time beside itself.

- 792189e: Check each plugin controller as NestJS built it.

  The check on a plugin's built module now covers its controllers' instances as
  well as its modules, because NestJS serves the object it built rather than the
  class the seal read. A plugin is refused when one of its controllers is built
  for each request or each injection (request-scoped, transient, or depending on
  something request-scoped), when a controller is built into something other
  than a plain instance of the class that was sealed, or when the instance holds
  a property of its own under a name its class's prototype chain holds. The
  Plugins screen reports it as refused rather than run (the API reports the
  reason as `module-refused`), and the rest of the instance starts without it,
  as with any other refused plugin.

- 8a7baa1: Serve and authorize a plugin's routes as they were checked.

  When the seal fixes a plugin controller's instance, it now also keeps each
  route it checked: the paths the router mounts it on, the request methods it
  answers, and the capabilities a request to it needs. A request reaches a
  plugin's controller only on a route kept for it, on one of those paths and
  with one of those methods. Any other request answers as though the plugin were
  not installed. The authorization guard authorizes a request on a checked route
  by what the seal kept, so the route is never public and needs the capabilities
  it was checked with.

  A checked controller's instance also takes no new properties and keeps its
  prototype, and its class's own prototype is frozen, as is the prototype of
  each base class the plugin's server entry defines. A plugin controller that
  adds a property to itself after it is built, rather than giving the field a
  value in its constructor or its declaration, now throws when it does so, and
  so does a plugin object that assigns to a method name of a frozen base class.
  Plugins that declare their routes with NestJS's decorators, as the plugin
  contract describes, are otherwise not affected.

- b8295b4: Serve a plugin's controllers only on the routes they were checked with.

  The guard that answers a disabled plugin's routes as not installed now also
  lets a request reach a plugin's controller only through a route the seal
  checked, with the method it fixed on the controller's instance. Any other
  method NestJS mounts for a plugin's controller answers as though the plugin
  were not installed. The guard takes the plugin from what the seal kept rather
  than from the controller's metadata. Plugins that declare their routes with
  NestJS's decorators, as the plugin contract describes, are not affected.

- 00bbb62: Fix each plugin controller instance to the methods and the class it was checked
  with.

  Once a plugin controller's instance passes the check on what NestJS built, it
  is given its own `constructor` and its own copy of each route method the seal
  read, each read-only and not configurable. Each route the seal checked then
  keeps the method and the class it was checked with, whatever the plugin's code
  does afterwards. A plugin whose controller instance cannot take them, such as
  one its constructor made non-extensible, is refused as `module-refused`, and
  the rest of the instance starts without it, as with any other refused plugin.

- c71c849: Harden how plugins are sealed, installed and switched.

  - The module seal also checks what a plugin's controllers, the guards,
    interceptors, pipes and filters they name, and `@Inject()` fields are
    constructed with, and matches a class by every name on its prototype chain.
  - A plugin is loaded only from the directory npm installed the consented
    package into, so two packages under one id never both load. A plugin refused
    after its factory ran stops being served.
  - `host.jobs` works: plugin queues are named `plugin/<id>/<name>`.
  - A plugin action's `deprecatedAliases` are composed under the plugin's id.
  - A reconcile records its outcome only on the releases it read, leaves the
    rows alone when another run took the installation over, and does not restart
    the process after a run that failed and changed nothing. Each archive's
    `openbrf.id` is checked before npm runs, and npm is given no git.
  - Installing and removing a plugin commit their rows, the art. 30 record, the
    recipient's art. 28 classification and the audit entries together; a removed
    plugin stops being served at once.

- 4047d01: Say why a plugin install failed in the reader's language.

  The plugins screen showed the installer's own English for every failed install,
  whatever language the interface was set to. An install failure is now recorded
  as a reason and the values its sentence needs - the download budget, a
  deadline, a size cap, a status code, a package name - and the screen and
  `openbrf plugin list` say it from the application's translations. Every way the
  install can fail has a reason of its own: a download that ran out of time or of
  the run's budget, a source the instance does not read or cannot reach, an
  archive that is too large or does not match its checksum, an archive that
  holds another package, and a failed or unexpected npm install.

  What the installer threw is still kept beside the reason, and `openbrf plugin
list` prints it under the sentence. A plugin that failed before this version
  has no reason recorded and keeps showing the text it had. The migration adds
  two columns and changes nothing already stored.

  Values taken from a plugin's archive, such as the package name its
  package.json gives, are stored cut to 214 characters. `openbrf plugin list`,
  `catalog` and `add` print control characters in anything they did not write
  themselves as escapes such as `\x1b`, so a catalog entry, an archive or an
  error cannot send instructions to the operator's terminal.

- ee0137e: A plugin install no longer changes a recipient the art. 28 record already
  classifies.

  The consent step asks where a plugin sends personal data only when the record
  has nothing for it, but the API recorded any answer an install carried. A
  consent screen opened before somebody classified the plugin, or a direct caller
  of the API, could therefore replace an agreement the board had recorded as in
  place with one being made, holding only the permission to install plugins and
  not the one that manages the data protection record.

  An install that answers for a plugin the record already classifies is now
  refused with `recipient-already-recorded` (409) before anything is written, and
  the consent screen says the record changed since it was opened and that the
  answer is changed on the data protection screen. An install that sends no
  answer goes ahead and leaves the record as it is. The art. 28 write also keeps
  a classification that lands between that check and the install's own write,
  and serialises concurrent classifications of one recipient, so they can no
  longer leave two open rows for it.

- f81693a: Install plugins from their verified archives alone, and load only the package
  the board consented to.

  The plugin installer runs npm offline, with a cache of its own that starts
  empty, no npm configuration from the host, and a minimal environment built from
  an allowlist. npm has nothing to install but the archives whose digests the
  catalog stated.

  `pluginPackageSchema` in `@openbrf/plugin-sdk` refuses a package whose
  `dependencies`, `optionalDependencies`, `bundleDependencies` or
  `bundledDependencies` is anything but absent, an empty map or an empty list, as
  the plugin contract requires. The loader
  reads the same schema, so such a package is reported as `manifest-invalid` and
  not loaded.

  A plugin must match the package name and version the board consented to. Before
  npm runs, the installer unpacks each archive it is about to hand npm the way npm
  does, with the same tar library and options in strict mode, and refuses a
  package whose `package.json` does not match or declares a dependency, or an
  archive the tar library warns about. After npm, it checks that the
  staged tree holds exactly the consented packages before it puts the new
  installation in place, and fails the install otherwise. At boot, a plugin
  that does not match is refused as `not-consented`, and the volume is reported
  as needing a reconcile.

- 9ee3a9b: Refuse a plugin install whose answer about where the plugin sends personal data
  the processor agreements would refuse. The answer is now checked before the
  consent is recorded.

  An independent controller with no reason given, a personal identity number in
  the recipient or the note, or an agreement said to be in place without a date or
  the terms art. 28(3) requires used to be refused only after the consent row was
  written. A direct caller of the API, such as a script, that sent such an answer
  then left a consent behind with no install, no processing activity in the record
  of processing activities and no classification among the processor agreements.
  The command-line tool sends no recipient answer, so it was not affected.

- dddda51: Read an empty field in a plugin install's answer about where the plugin sends
  personal data as no answer. Also keep an agreement's own details off a recipient
  that is not a processor.

  - An empty other party no longer hides the recipient the board named, so an
    independent controller is recorded under that name. An empty recipient
    likewise no longer hides the other party.
  - An empty note on a plugin that sends nothing outside is no longer refused as
    a missing reason. The instance's own reason, that the plugin runs in its own
    process, is recorded in its place.
  - For an independent controller, the date the agreement was signed, its
    reference and its note on sub-processors are no longer recorded among the
    processor agreements. They describe the contract GDPR art. 28(3) requires of
    a processor, and an independent controller has none.

- 327e502: Keep the restart notice on the plugins screen until the new process serves the
  plugin.

  An install or a removal is answered as soon as its reconcile is queued, and the
  job then runs the whole reconcile, npm included, before it hands over to the
  restart. Through that window the plugin overview reported no restart pending, so
  the screen's first check after two seconds could take the outgoing process's
  answer for the replacement's: it stopped waiting and stayed on "Installerat,
  väntar på omstart" while the new process was already running the plugin.

  The overview now reports a restart pending from the moment an operation that ends
  in one is accepted, and from the moment the worker picks up a reconcile the
  command-line tool queued, until the process is replaced. It also names the
  process that answered, and the screen leaves the restart notice only once a
  different process answers with nothing pending.

  A removal while plugins are switched off no longer answers that the application
  is restarting: nothing runs the reconcile then, and nothing is replaced.

- 550e3f0: Check that a plugin controller's prototype names it, and keep each route's
  required permissions as the list that was checked.

  The seal now refuses a plugin controller whose prototype names another class
  as its constructor, as an ES5-style subclass's can, because the permission
  check finds the class it reads a route's required permissions from through
  that name. The same was already refused once the application was built; the
  seal now refuses it before. The list of permissions a single route requires
  is now written back as a compact copy of what the seal read, as the
  controller's own list already was. The Plugins screen reports such a plugin
  as refused rather than run (the API reports the reason as `module-refused`),
  and the rest of the instance starts without it, as with any other refused
  plugin.

- b7997be: A plugin module whose dynamic module lists a forward reference in its
  `imports`, as `{ module: PluginModule, imports: [forwardRef(() => Shared)] }`,
  now builds. The seal puts the module the reference resolved to in its place,
  and NestJS builds that module once. Before, the build failed with a
  `TypeError` and the plugin was skipped as `module-failed`. A list that cannot
  take the module, such as a frozen array, is refused with `module-refused`.
- db2e95e: Harden the plugin module seal.

  - The seal checks what a plugin's module class is constructed with, and the
    guards, interceptors, pipes and filters any of its provider classes name, as
    it already did for controllers. A plugin whose module class or provider
    reaches a service a plugin may not hold is refused with
    `forbidden-injection`.
  - The seal refuses a plugin module whose metadata or declarations it cannot
    read in full, with `module-refused`. Modules declared in the usual way with
    NestJS's decorators load as before.
  - A plugin whose module the seal cannot finish reading is refused with
    `module-refused` rather than failing the boot.

- aea18bc: Harden the plugin module seal further.

  - The lists and declarations the seal reads of a plugin's module are frozen
    as they are read, and a dynamic module's lists are fixed to it, so what the
    seal checked is what NestJS builds.
  - What the seal reads of a plugin's classes is read again at the end of the
    seal, before the application is built and once it is built, and compared
    with what the seal first read of them. A plugin whose module no longer
    reads as it was checked is refused with `module-refused`.
  - What NestJS built from a plugin's module is compared with what the seal
    read, once it is built and before it is initialised: the modules it imports,
    whether any is global, the providers and controllers each holds, and what
    each was constructed with. A plugin whose built module differs is refused
    with `module-refused`.
  - A module counts as one of the application's own by the registration NestJS
    made of it rather than by its class, so a dynamic module of an application
    class that the application does not declare is checked as the plugin's.
  - A plugin's dynamic module may hold only the fields NestJS reads, and none
    behind a getter.

  Plugins declared in the usual way load unchanged.

- 0936507: Harden the plugin module seal. Plugin modules are validated more strictly;
  a module that fails is refused as before, and plugins declared in the usual
  way load unchanged.
- e4df6bf: The plugin module seal again builds a dynamic module that lists a forward
  reference in its `imports`. The seal now closes that list to new entries when
  it reads it, writes the resolved modules into it, and only then freezes it. A
  plugin whose code changes an entry of that list in between is refused with
  `module-refused`.
- 750389c: Harden the plugin module seal further.

  - A plugin controller's paths and required capabilities, on the class and on
    each route, must be plain arrays where they are lists. A plugin that gives
    them any other way is refused with `module-refused`. The capability list the
    seal writes onto the controller is now always its own copy.
  - A module class, provider or controller given as a proxy is refused with
    `module-refused`, and the log line says so.
  - The class, method and path names the seal writes to the log are read
    without running the plugin's code and kept to one line, as an error's name
    already was. The paths the boot log repeats for a served controller are
    escaped onto one line and bounded the same way.

- 933e778: Narrow the art. 20 export field by field in the five sections that passed the
  access report's rows through whole. The residencies lose the purge date, the
  publication consents lose the board's note, the bookings and the event sign-ups
  lose the date the purge can reach them, the motions lose their status, closing
  date and erasure date, and the sign-ups lose whether the board called the date
  off. The export now carries the address the person signs in with
  (`person.signInEmail`), which they gave and which the whole-account omission
  dropped.
- 67098c1: Wait for sign-in links still being sent when the application shuts down, for up
  to five seconds and before the database connection closes, so a restart does not
  drop a link whose request was already answered. The HTTP server stops taking
  requests first, so a sign-in request accepted as the shutdown begins is either
  answered and delivered or refused, never answered and lost.

  An approved account request whose invitation fails for a reason other than the
  mail not leaving (a fault in the application or the database) is now logged as
  an error rather than a warning. The board is still told that the person is in
  the register and needs an invitation from the person's own view, because the
  approval stands.

  The security headers are registered where the application is built, so the
  suites that build the application with `createApplication` see the headers a
  running instance sends. The message shown when a connected app's return address
  is refused now says it may be not allowed as well as incomplete.

- dbc309d: Name the mail server on every row of the record of processing that mails
  somebody (art. 30(1)(d)): meeting notices, bookings, account and move mail,
  invitations and the contact form, not only the news, and the personal data
  breach and register reporting rows. Meeting records and
  bookings list e-mail among their personal data. The SMS gateway is named only
  when it is the configured driver, by its host, as the processor register names
  it. Bookings, events and motions count former residents among their data
  subjects. Rows the board has not edited are rewritten at the next start.
- 6991b51: Keep a recipient the board recorded itself off the record of processors once it
  is ended.

  A board member could save a new classification for such a recipient at the same
  moment another board member ended it. The save then put the recipient back on
  the record. Now the save is refused as it would be for any recipient that is not
  there, and the recipient stays ended.

- dd55b59: Hold the record of processors to one current classification per recipient.

  The database now refuses a second open classification for a recipient. Before
  this, only the code that writes one kept that rule. An instance that already
  has two open classifications for one recipient, which two classifications
  recorded at the same moment on an older version could leave, keeps the newest.
  Each older one is closed as replaced at the moment the next was recorded, so it
  stays in the record's history. Nothing is deleted.

- a1258ee: Name the mail recipient in the processor register by the mail the instance
  actually sends through.

  The register listed the mail as "Mail server" under the key `smtp` whichever
  driver `OPENBRF_MAIL_DRIVER` chose. With the mail set in the environment, an
  agreement the board had recorded with its own former provider was shown against
  the host's SMTP relay or HTTP mail API, which it does not cover.

  The mail row is now one of three recipients, each with its own key and label:
  the server the board entered (`smtp`, "Mail server"), the host's SMTP relay
  (`hostSmtp`, "Host's mail server") and the host's mail API (`mailApi`, "Host's
  mail API"). While the host's mail is in use, the host's service is a recipient
  the board has not classified yet, and the board's own agreement is not listed.
  That agreement stays recorded and applies again once the board's settings send
  the mail. Existing rows are not migrated: every row under `smtp` describes the
  board's own server.

- 0748615: Classify storage on the association's own disk in the processor register
  without asking the board.

  An instance storing files on its own disk has no processor for storage, and the
  register already suggested so, yet it still listed storage as a recipient the
  board had not classified. The instance now records it as no processor when it
  starts, once setup has completed. When the storage driver moves to a bucket,
  that row is closed with the reason `driver-changed` and the board is asked
  again. A classification the board recorded itself is never closed or replaced,
  whichever driver the instance uses.

  Both the recording and the closing appear in the audit log as the system's own
  acts, with no person behind them.

- d43e3dd: Accept a report from the website's issue form when its optional fields are
  left blank.

  A browser sends every field of a form, and one left untouched arrives as an
  empty value. The issue report form read an empty email address as an address
  that is not one and refused the whole report, so a report from somebody who
  left no address could not be sent from any real browser. An optional field of
  the website's forms that is blank, or only spaces, is now read as not given at
  all. An address that is given is still checked, and a report with one that is
  not an address is still refused.

- 1a3d778: Fix a second set of defects in the public website, the page and menu editors
  and the document archive.

  - `news_list` keeps paging past a news item removed since the last call. Its
    cursor has a new form: a cursor issued before this release answers
    `not-found`, so start the list again without a cursor.
  - A `page_list` cursor whose sort order is out of range answers `not-found`
    rather than a server error.
  - A personal identity number in a link's address is found even when a stray
    `%` stands elsewhere in the link, or when the number's hyphen is escaped
    twice. The refusal places it by its block, without an offset into the
    block's words, and offsets in a FAQ block no longer shift past a link in an
    earlier answer. A link escaped more than four times over is decoded no
    further: the block is refused as if it carried a number, and the editor
    warns about it the same way.
  - A document for the members or the public whose title, binder or file name
    carries a personal identity number is refused, since a document list on the
    website prints all three. The file name is read as it will be stored, after
    the characters a stored name may not hold are removed. A board document is
    not affected.
  - A new page goes before the privacy notice in the board's list after the
    pages have been reordered, unless the board moved the notice up the list.
  - Removing a page records a menu entry under another entry for the same page
    once, as its parent's child, instead of twice.
  - `/nyheter?sida=` with seven or more digits shows the last page, like any
    other number past the end, and the index counts the news and reads the page
    at the same time.

- fde55f7: Fix a set of defects in the public website and the page and menu editors.

  - A personal identity number in a link's address (a `mailto:` subject line,
    say) is refused on a published page, as one in the text already was. The
    page editor warns about it too.
  - The site menu can no longer end up with two entries hanging from each other,
    or with a third level, when two board members arrange it at once.
  - Removing a page records each menu entry it takes with it in the audit log,
    and records the unpublication even when the page was published after it was
    read.
  - Two pages created or renamed to the same address at once answer the loser
    with "address taken" rather than a server error.
  - The privacy notice is never served at `/` as the front page, whatever order
    the pages are in, and a new page is placed before it in the board's list.
  - `page_list` keeps paging past a page deleted since the last call. Its cursor
    has a new form: a cursor issued before this release answers `not-found`, so
    start the list again without a cursor.
  - A FAQ answer of nothing but spaces is dropped when the page is saved, not
    accepted and then lost on the next read.
  - The news index at `/nyheter` lists 20 items per page, with links to older and
    newer items, instead of every item on every request.
  - A public form message at the form's own length limit is no longer refused
    because of how the browser sends its line breaks.
  - A document list reads only the binders it shows from the database.
  - Every public page sends `referrer-policy: same-origin`, varies on
    `accept-language` and may not be framed by another site. A link written as
    `HTTPS://` gets `rel="noopener noreferrer"` like any other external link.

- 933e778: Show the board the date the purge will act on a person, not the date a single
  residency ended. The purge waits for the last residency to end and leaves a
  person alone while they hold a board seat or a system role, or while a legal
  hold or a restriction stands, so a person who moved to another apartment no
  longer shows a past date on the old row, and a person the purge will not touch
  shows none.

  The date also waits on what has not ended yet: a board term recorded from a day
  to come, and a move-out scheduled for a day to come, both keep the person out of
  the purge, so neither shows a date.

- 1ecf5af: Keep the data of a person under a restriction of processing (GDPR art. 18)
  out of the charge, fee, key order, sublet application and board mailbox
  purges.

  The charge, fee, key order, sublet application and board mailbox purges
  exempted people under a legal hold but not people under a restriction, so a
  restricted person's rows were erased once their retention window ran out -
  the one thing art. 18(2) says the association must not do. Each of them now
  asks the question every other purge already asks: a legal hold or a standing
  restriction keeps the rows, and lifting the restriction lets the next run
  erase them.

  A restriction granted while a purge is running is honoured too. The purge
  reads it again after taking the person's legal hold lock, and granting a
  restriction now also takes the registry lock the board mailbox purge waits on,
  so the grant and the purge can no longer pass each other.

- 7b08dec: Make the job queue's table refuse a partitioned queue, or one with a job table
  of its own, for every role.

  The job schema installer already stops when `pgboss.queue` holds such a row,
  because pg-boss builds SQL from its table name when it migrates the schema as
  the owner. That check ran once, before the migration, so a role that can write
  `pgboss.queue` - the application's, which declares queues at runtime - could
  add one in the gap while a migration was pending. The installer now also puts a
  trigger on the table, owned by the schema owner, that rejects an insert or an
  update that sets `partition` or a `table_name` other than `job_common`. The
  application's ordinary queues are unaffected, and the application's role can
  neither disable nor drop the trigger; only the schema owner can remove it.

- f9840a5: Rate-limit the export of a person's own data (`POST /api/data-portability/mine`).

  Gathering the report holds a database connection for as long as its transaction
  runs, so a few people exporting at once could hold the default pool of ten and
  starve the rest of the API. Each person now has three exports a minute, the
  instance twelve a minute in all, and no more than three are prepared at once,
  which is the most connections exports can hold however long their transaction
  takes. A request over a budget, or one that finds all three under way, is
  answered 429 with a `Retry-After` header before anything is gathered, and writes
  no audit entry. A person who is refused takes nothing from the instance's
  budget, so one person pressing the button in a loop cannot use up what
  everybody else exports from. A request refused as busy takes nothing from the
  person's own budget either.

  The two refusals have their own reasons, `export-rate-limited` and
  `export-busy`, because the person can act on only the first. The download on the
  profile page shows a sentence for each, in Swedish and English, instead of the
  general failure.

  The counters are in memory and per process, like the limiter on the public
  forms; the instance is one process, so that is the instance's whole count. An
  instance run as more than one application container multiplies every one of
  these limits by the number of containers.

- 933e778: Refuse a phone number the register cannot read when the board adds a person, as
  an unreadable email address already is. A number with no digits was stored and
  looked like a number on file while no search could match it. The add-person form
  names the refusal. An email address already on file is not refused: a household
  can share one address, and the sign-up approval already refuses to guess between
  the people on it.
- acfd6ce: Answer `invalid-redirect-uri` when registering a connected app by hand with an
  address the instance refuses (this machine over https, a loopback host written
  some other way, or an address with a user name or a fragment). It answered
  `invalid-body` before, so the form could not say which address was the problem.
  A malformed body still answers `invalid-body`.
- a033e55: Keep the line breaks in a fault report's description on the data subject access
  report, and correct the section counts that had gone stale as sections were
  added.

  An issue description was the one piece of somebody's own writing on the document
  that collapsed to a single line, while the motion body, the comment body and
  both issue panels keep theirs. A description written as a list of observations
  read as one run-on sentence, which is the association altering what it hands
  back under art. 15.

  The counts: the lien note called itself the only section not keyed on a person
  column, where a termination is the other, and the two now name each other rather
  than number themselves. The web mirror still said three sections state a per-row
  retention date and numbered the motion and the sign-up against that three, where
  four now do - the news comments being the fourth, which the mirror had left
  unnumbered. The report's own test counted the same three.

  The issues section had no fixture row in the report's own test, so nothing
  rendered it. It has one now, written on three lines, and one test asserts all
  three free-text sections keep their breaks so a fourth cannot arrive without it.

- 81f7319: Put a motion in the data subject access report's completeness fixture, and take
  the screenshot walk to the end of its own manifest.

  **The report's fixture held no motion.** That spec exists to say the document
  omits nothing: it puts a row in every store the product has and asserts each
  section found it, so a section with no fixture row asserts an empty list against
  whatever the service does, and the header comment enumerating the stores did not
  name this one. Two rows now, because this is one of the four sections that state
  an erasure date per row and one of the two states a motion can be in has no date
  to state: the motion the board has received is asserted to carry its own date two
  years after it was closed, as the booking, the sign-up and the news comment
  beside it are, and the motion still with the board is asserted to carry none - it
  has no closing date to count from, and the association is still processing it.
  Both are dated from the day the run happens rather than from a fixed point in the
  past, so no purge another suite drives can reach either of them.

  **The screenshot walk stopped two thirds of the way through its own manifest.** A
  walk visits sixty screens as four different people, and it signed in again every
  time it came back to one of them: sixteen sign-ins where three people appear.
  Every request to an auth endpoint counts against the same allowance of twenty a
  minute per client, sign-ins and the session check each page load makes alike, so
  the administrator's twenty-first was refused, the client read the refusal as no
  session, and the screen it happened on went to the sign-in form - where the walk
  failed on a control that is not on that form.

  Each person now signs in once and the session cookie is handed back to the
  browser they return in, which is three sign-ins instead of sixteen. The cookies
  alone travel and never the rest of the storage, so no screen inherits a theme
  preference from the one before it and both images of every screen are still of a
  viewer whose computer chooses the mode. What each client spends is then counted
  as the instance answers it, and a person whose allowance is nearly gone waits for
  the window to roll rather than being refused: a walk photographing sixty screens
  in under a minute opens more of the application than a board member opens in a
  minute, so it waits where a member would not have to. The limit is untouched and
  each person still has the one address they had - the address separates members who
  really are at different homes, and it was never what kept any of them inside
  their own allowance.

  **And two entries in the manifest that no walk had ever reached.** The screen
  recording the deadline the bylaws set filled a field whose label begins "Dag" and
  clicked a "Spara" on the one route that carries every settings card, where two
  cards hold a field beginning that way and seven offer that save: both steps
  matched two things, which is a refusal rather than a setting written into another
  card. An entry can now name the card a control is looked for inside, which is
  what a person reading that screen does. The same entry then waited for the
  confirmation the save puts up, and the card takes that down as soon as the
  settings it saved arrive again - a race with a read that answers in a few hundred
  milliseconds. It waits for the card itself now, and whether the clause was really
  stored is asserted one screen later on the member's own, where a date computed
  from it is the first thing that entry looks for.

  All sixty screens are photographed in both modes.

- 933e778: State on the access report that a restriction of processing suspends the purge,
  as a legal hold does. The retention section named only holds, so a person under
  a restriction read a purge date as something that was going to happen. It now
  carries `processingRestricted` beside `onLegalHold`, and the screen shows both.
- 933e778: Leave the person's id off the rows of the resident directory. A neighbour reads
  who lives where, and the id was a handle on a person that nothing in their view
  used. The row key is the residency's id, or for somebody with no apartment a
  digest of the person's, so it identifies nobody. The board's rows still carry
  the id, which is how the board opens a person.
- dbc309d: Show residents only who lives here today in the resident directory.

  Any resident could list every former household with its move-out date, a
  buyer before their move-in, and the administrator, the property manager and
  anybody not yet placed. The resident directory now keeps residencies held today
  and, of the people with no residency held today, those who hold a board seat
  today, including a board member who has moved out. A resident's row carries no
  move-out date and no "moved out" sign. The web no longer offers the "Moved out"
  tab to residents. A person under a restriction of processing is also
  left out by the directory's second check, as the query already did.

- ca89fbc: Decide whether a request reaches a connected-app resource from the path as the
  router reads it, percent-escapes decoded, and from the route it matched, so
  every spelling of the resource path takes the Bearer-only branch.
- 53f44cf: The `migrate` service now refuses a `DATABASE_URL` that names another server or
  database than `POSTGRES_HOST`, `POSTGRES_PORT` and `POSTGRES_DB`, unless
  `DATABASE_URL_RUNTIME` is set. The application builds its own connection from
  those three, so the runtime role was constrained on one server while the
  application connected to another.
- 53f44cf: Ask for the password again when the mail server, the board mailbox's server or
  the SMS gateway changes, or when the encrypted connection to one is turned off.

  Leaving a password field empty keeps the one stored, which is what saving the
  rest of a form should do. It also meant that a new host, port, SMS provider or
  gateway address was saved beside the old credential, and the next message
  presented that credential to whatever answered at the new address. Turning off
  the encrypted connection to the same host and port did the same in clear text.
  A save that moves the endpoint now has to carry the secret again, or clear it,
  and the settings screen says so when it does not.

  When another save changes the server or the stored secret while this one runs,
  the screen says that instead, with a message of its own, since this save may
  have changed nothing about the server.

- ca89fbc: Send `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: same-origin` on every response whose route did not set its
  own, and `Strict-Transport-Security` in production over https, so the
  application's pages and answers cannot be framed by another site.
- 61016f6: Installing and uninstalling a plugin or theme of the same id no longer race.

  Two administrators acting on one id at the same moment could let an install
  read the package as installed while the uninstall was removing it. A deprecated
  entry, which may be installed again only where it is already installed, could
  then be installed afresh over what had just been removed. Install and uninstall
  of one plugin, and install, compose and uninstall of one theme, now take a lock
  for that id and run one after the other, the install gates included. Different
  ids, and a plugin and a theme sharing an id, do not wait for each other.

  A change that waits too long for another one on the same id, or arrives while
  the instance already runs four such changes, is answered 429 with the reason
  `package-busy` and a `Retry-After`, and the plugin and theme screens say to try
  again in a moment. A change whose database lock is lost part way stops before
  its next write and is answered 503 with the reason `package-lock-lost`. Each
  lock holds a database connection of its own, so the runtime role's connection
  limit is now four higher: nineteen at the default pool size.

- 12bd006: Give the session read a budget of its own, so a signed-in board member is not
  returned to the sign-in form part-way through an afternoon.

  **One budget was doing two jobs.** Better Auth counts its endpoints per client
  address and per path, and this instance set one default for all of them: twenty
  requests, and the count clears only after a whole window in which that address
  asked for nothing on that path. On a credential path that shape is right, because
  the caller it bounds is a script that never stops. On the session read it is the
  wrong shape entirely, and the session read is the path the interface asks most:
  a route guard reads the session before every guarded screen renders, the client's
  session store reads it again when a page loads, and it reads it once more each
  time the window regains focus. None of that is a rate the application sets, and a
  person with two tabs open produces two of those streams. So about a dozen guarded
  navigations spent the twenty, the next read was answered 429, and the client
  cannot tell a refusal from having no session - the screen went to the sign-in
  form while the session behind it was still valid.

  The session read now has a budget of its own: two hundred inside a window of ten
  seconds. Wider because the two paths ask different questions - a sign-in is a
  guess at a credential and worth counting tightly, while a session read presents
  the cookie the browser already holds and answers with the session or with null,
  so there is nothing in it to guess and a budget on it changes what an attacker
  gains by nothing at all. What it does bound is the cost of the read, which is two
  indexed lookups. Ten seconds rather than sixty because of how the count clears: a
  person who leaves a screen alone for ten seconds hands the budget back, where a
  minute-long window means an interface in continuous use never gets one back.

  **Nothing that guards a credential moved.** The rule is written for one exact
  path and no pattern, and every path where guessing is the attack keeps the
  tighter rule it already had: three attempts per ten seconds on sign-in, sign-up
  and changing a password or an address, three per ten on the second factor, five a
  minute on the two the sign-in link uses. Three tests hold that line - one over
  HTTP asserting the sign-in path is refused inside fewer attempts than the general
  budget allows, one asserting the session read is still bounded and by how much,
  and one on the configuration asserting it names the session read and nothing
  else.

  **And the screenshot walk stops working around it.** The walk paced itself to
  stay clear of the shared budget, counting every auth request one client made
  against a single allowance of twenty and waiting where a person never would. It
  was measured at its most demanding stretch: twenty-nine session reads by the
  administrator with no ten-second pause among them, against the twenty the
  session read used to have - so the pacing was load-bearing, and against the
  session read's own two hundred it no longer is. The walk photographs its sixty
  screens in both modes without waiting, and in place of the pacing it watches for
  the refusal itself: a 429 on any auth endpoint now fails the walk naming the path
  and the screen, rather than surfacing screens later as a control that is not on
  the sign-in form.

- f408d9d: The lengths the housing cooperative's name, the bankgiro and plusgiro numbers and the SMS sender name may have are now shared between the settings forms and the server that enforces them (`HOUSING_COOPERATIVE_LIMITS`, `FINANCE_LIMITS` and `SMS_LIMITS` in `@openbrf/shared`), like the other settings lengths. No limit changes.
- f408d9d: The lengths the address, apartment, issue type and bookable resource forms and the first-boot administrator form allow, and the shortest password an account may have, are now shared between the forms and the server that enforces them (`ADDRESS_LIMITS`, `BOOKABLE_RESOURCE_LIMITS`, `ISSUE_TYPE_LIMITS`, `ADMINISTRATOR_LIMITS` and `MIN_PASSWORD_LENGTH` in `@openbrf/shared`), so the two cannot drift apart. No limit changes.
- f2f3f87: Two first-administrator submissions sent at the same instant can no longer both
  succeed. The check that the instance is unclaimed is taken under the lock every
  change to the administrators takes, and counts ADMIN grants as well as accounts,
  so the second submission is refused with `already-claimed`.
- 25552fb: Export `parseSha512`, `formatSha512` and `IntegrityError` from the plugin SDK.

  The instance reads a catalog entry's sha512 digest with them, so the catalog's
  own check can accept exactly the spellings the instance accepts, instead of a
  copy that drifts. The SDK reads a digest into a `Uint8Array` without `Buffer`
  or `node:crypto`, so it still bundles into the browser, where neither exists.
  Hashing and the constant-time comparison stay in the API.

- 21be93c: Gather the board's data subject access report in the same slots as a member's
  export of their own data.

  `POST /api/data-subject-reports/persons/:personId` runs the same long report
  transaction as `POST /api/data-portability/mine`, and so holds a pooled
  database connection for as long as it runs, but it had no limit: a few reports
  asked for at once could still hold the pool. The cap of three reports gathered
  at once now belongs to the report service, which both routes go through, so
  the board's reports and the members' exports share one set of three slots. A
  request that finds all three taken, on either route, is answered 429
  `export-busy` with a `Retry-After` header before anything is read, and writes
  no audit entry.

  The member's per-person and instance budgets stay where they were. An export
  the report service turns away as busy is charged to neither, as before. The
  board's route has no per-person budget: it is held by the board and an
  administrator, and the slots are what bound the connections.

  The access report screen says when the instance is busy, in Swedish and
  English, instead of the general failure, and offers to try again.

- a1685c6: Refuse a field no block type declares on the contact form, the issue report
  form and the news teaser, as the other eight blocks already did.

  The write path is strict about keys as well as about values, for one reason: a
  body accepted without the part that was sent is the one answer a write path must
  not give. Those three schemas stripped instead. A block written with a
  misspelled key was accepted, the board was answered that the page had been
  saved, and the field was gone. A body naming fields for a form to ask for was
  accepted the same way, and stored as the form this platform fixes the fields of,
  with nothing said about what had been dropped. The route now names the field path
  back as an invalid body, and never the value.

  Nothing already stored is at risk. The strict schema is on the write path alone.
  The renderer and the board's own editor read a stored body through the total
  parser, which has never looked at a key it does not declare: a page carrying one
  renders exactly as it did, and is handed to the editor without it, so a save
  sends back only the keys the schema knows. The tightening can refuse a body being
  written; it cannot refuse a page an instance already has.

- ca89fbc: Listen on the validated `PORT`, so an empty value means the default rather than
  a random port. Log only whether an SMTP sender or a board mailbox address is
  set, not the address. Two processes generating the development encryption key
  at once now agree on one key instead of the second overwriting the first.
- 01bd75d: Refuse an SMTP or board mailbox host that holds a line break or another control
  character. No host name or address has one, and the host is written into the
  log when the settings are saved, so a line break in it could add a line of its
  own there. The SMTP card no longer warns about settings saved before TLS was
  required: the instance now requires STARTTLS of a server that is not on the same
  machine whatever the stored settings say, so the risk it described is gone.
- a8e7215: Let a host allow an SMTP relay without STARTTLS on a network it trusts.

  The relay set in the environment has to upgrade through STARTTLS before the
  instance signs in, unless it is on loopback. A Postfix sidecar on the Compose
  network (`OPENBRF_SMTP_HOST=postfix`) that offers no STARTTLS passed the check at
  start and then failed every send. `OPENBRF_SMTP_REQUIRE_TLS=false` now allows it,
  and the instance logs a warning at start while it is set. Unset, nothing changes:
  a relay off loopback still gets no sign-in in the clear. `true` requires STARTTLS
  from a relay on loopback too.

- 0703465: Harden how the API reads a calendar date.

  Every endpoint that takes a "YYYY-MM-DD" date now refuses one the calendar does
  not have, such as the 30th of February or a 13th month, with a 400 rather than
  reading it as a different day. Moves, lien notes and positions of trust also
  refuse it in the service, and a member list import checks the move-in date
  chosen for the whole file as it checks the date in a row.

  A lien note cannot be dated or released on a day that has not arrived, and a
  release cannot be dated before the note it releases.

- c71c849: Harden installing, activating and removing themes.

  - A catalog install no longer replaces a theme composed on the instance under
    the same id (`theme-composed`, 409); the themes screen says why.
  - Activating, removing and installing a theme check the other themes under one
    lock in the transaction that writes, and a removal writes `THEME_REMOVED`.
  - A theme's previous version is kept until its install has committed, and
    undoing a failed install or removal never touches the files of a later
    install of the same id.
  - Theme asset URLs carry the package's checksum, so an upgrade is not served
    stale, and the compose route holds token names to `[a-z0-9-]`.

- 5b68b6c: Check the previous holder of a transfer against the register before the
  transfer is recorded.

  A transfer recorded with a move-in or a move-out now has to name a previous
  holder who was a tenant-owner of that apartment when it passed on: a `MEMBER`
  residency on it, held on the transfer day or up to it, so a previous holder who
  moved out on that day still qualifies. A previous holder who never
  held the apartment, held it only as a resident, or had stopped holding it is
  refused with `seller-not-tenant-owner` (409), and a transfer naming the same
  person as previous holder and acquirer is refused with `seller-is-acquirer`
  (400). Transfer rows cannot be deleted, so both are refused before anything is
  written, and the move they came with is refused with them.

  The move takes the transition lock of both parties to the transfer, in a fixed
  order, so the previous holder's residencies cannot change while they are
  checked.

  The move-in and move-out forms show both refusals in the interface's own words,
  naming the previous and the new holder as the form's fields do.

- 53f44cf: Log an unexpected request failure by its class and call frames, never its
  message.

  A failure no rule anticipated reached Nest's own last resort, which wrote the
  error's message and stack to the log. Those messages are composed where the
  error is thrown, from whatever was being handled: a mail server's rejection
  quotes the recipient's address, and a database error can quote the value that
  broke a constraint. Such failures are now answered with the same generic 500 and
  logged as the failure's class, its code where it has one, and its call frames,
  which is what ADR 0007 asks of every other log line. Server-side refusals and a
  website not-found page that cannot be rendered are logged the same way.

- 347cffc: Harden the sign-in library's user-update surface.

  The library's own user-update endpoint, which this product does not use, now
  answers 404. The account's `personId` is declared as set by the application
  only, and a test requires every user field the application or a plugin adds to
  be declared the same way unless it is on an explicit list, which is empty.

- Updated dependencies [3e15661]
- Updated dependencies [87bcb63]
- Updated dependencies [b4954e7]
- Updated dependencies [a7be0c9]
- Updated dependencies [f408d9d]
- Updated dependencies [66e2d3c]
- Updated dependencies [37a0def]
- Updated dependencies [2f8ddd9]
- Updated dependencies [f408d9d]
- Updated dependencies [374dd42]
- Updated dependencies [a41bd1c]
- Updated dependencies [df165a8]
- Updated dependencies [dbc309d]
- Updated dependencies [933e778]
- Updated dependencies [381f639]
- Updated dependencies [f5f23a6]
- Updated dependencies [d627751]
- Updated dependencies [729ede4]
- Updated dependencies [b08a33a]
- Updated dependencies [0a835aa]
- Updated dependencies [a41bd1c]
- Updated dependencies [edcb7ed]
- Updated dependencies [fb94375]
- Updated dependencies [ca89fbc]
- Updated dependencies [241d9db]
- Updated dependencies [4464ee7]
- Updated dependencies [c229871]
- Updated dependencies [e50dd93]
- Updated dependencies [912bf9e]
- Updated dependencies [97261b3]
- Updated dependencies [e881b32]
- Updated dependencies [dd64599]
- Updated dependencies [a1eaf25]
- Updated dependencies [68a7471]
- Updated dependencies [fc9dba7]
- Updated dependencies [a41bd1c]
- Updated dependencies [8ef5487]
- Updated dependencies [a1eaf25]
- Updated dependencies [dbc309d]
- Updated dependencies [425f11e]
- Updated dependencies [f408d9d]
- Updated dependencies [d4d763d]
- Updated dependencies [d315c66]
- Updated dependencies [933e778]
- Updated dependencies [db32272]
- Updated dependencies [a0ee312]
- Updated dependencies [c4c4280]
- Updated dependencies [711c214]
- Updated dependencies [2b6e8f1]
- Updated dependencies [f9faabe]
- Updated dependencies [bb70934]
- Updated dependencies [89a7e72]
- Updated dependencies [86b8cbc]
- Updated dependencies [645c17c]
- Updated dependencies [f408d9d]
- Updated dependencies [a8825d1]
- Updated dependencies [82a71e5]
- Updated dependencies [aa27060]
- Updated dependencies [710582b]
- Updated dependencies [edc9eb1]
- Updated dependencies [53f44cf]
- Updated dependencies [933e778]
- Updated dependencies [1898cd6]
- Updated dependencies [a2b2ec0]
- Updated dependencies [ca1b7e5]
- Updated dependencies [dffcafc]
- Updated dependencies [d676138]
- Updated dependencies [39d961e]
- Updated dependencies [26c5236]
- Updated dependencies [35b3f73]
- Updated dependencies [f756e48]
- Updated dependencies [dffcafc]
- Updated dependencies [df3bcf1]
- Updated dependencies [6ef5a70]
- Updated dependencies [a41bd1c]
- Updated dependencies [f408d9d]
- Updated dependencies [2a8ba9b]
- Updated dependencies [a41bd1c]
- Updated dependencies [094f814]
- Updated dependencies [04739fb]
- Updated dependencies [f9befbb]
- Updated dependencies [c00a615]
- Updated dependencies [cbda3fe]
- Updated dependencies [02f745b]
- Updated dependencies [a59d97a]
- Updated dependencies [2660f5c]
- Updated dependencies [19d1298]
- Updated dependencies [29d4db1]
- Updated dependencies [2bf7072]
- Updated dependencies [2bf7072]
- Updated dependencies [4ff70df]
- Updated dependencies [dc62953]
- Updated dependencies [241d9db]
- Updated dependencies [d592c19]
- Updated dependencies [c019cd2]
- Updated dependencies [2d792c6]
- Updated dependencies [4ddfe44]
- Updated dependencies [f2f3f87]
- Updated dependencies [e7776cb]
- Updated dependencies [be66b1f]
- Updated dependencies [30456a5]
- Updated dependencies [8a0dbee]
- Updated dependencies [a288424]
- Updated dependencies [6011cfb]
- Updated dependencies [fbe000b]
- Updated dependencies [8afe923]
- Updated dependencies [fbe000b]
- Updated dependencies [73ec00a]
- Updated dependencies [f408d9d]
- Updated dependencies [2ea6f35]
- Updated dependencies [a41bd1c]
- Updated dependencies [2bf7072]
- Updated dependencies [26c5236]
- Updated dependencies [17c431d]
- Updated dependencies [9e590ee]
- Updated dependencies [c71c849]
- Updated dependencies [4047d01]
- Updated dependencies [ee0137e]
- Updated dependencies [f81693a]
- Updated dependencies [539c961]
- Updated dependencies [4b2deb9]
- Updated dependencies [67098c1]
- Updated dependencies [1ba7384]
- Updated dependencies [a1258ee]
- Updated dependencies [b7da25f]
- Updated dependencies [24ed1a8]
- Updated dependencies [1a3d778]
- Updated dependencies [fde55f7]
- Updated dependencies [a9645d7]
- Updated dependencies [f9840a5]
- Updated dependencies [8521104]
- Updated dependencies [933e778]
- Updated dependencies [a41bd1c]
- Updated dependencies [694c27b]
- Updated dependencies [c9c9e4e]
- Updated dependencies [c64fe4a]
- Updated dependencies [4214b99]
- Updated dependencies [2693aec]
- Updated dependencies [3a515aa]
- Updated dependencies [bfbfeca]
- Updated dependencies [933e778]
- Updated dependencies [cb30f23]
- Updated dependencies [3f34097]
- Updated dependencies [91f0d05]
- Updated dependencies [53f44cf]
- Updated dependencies [b202b27]
- Updated dependencies [61016f6]
- Updated dependencies [f408d9d]
- Updated dependencies [f408d9d]
- Updated dependencies [241d9db]
- Updated dependencies [241d9db]
- Updated dependencies [25b80c5]
- Updated dependencies [25552fb]
- Updated dependencies [21be93c]
- Updated dependencies [241d9db]
- Updated dependencies [ca89fbc]
- Updated dependencies [241d9db]
- Updated dependencies [1f7efd1]
- Updated dependencies [2b229e0]
- Updated dependencies [bf1cdae]
- Updated dependencies [654197e]
- Updated dependencies [e29bcc0]
- Updated dependencies [01bd75d]
- Updated dependencies [3e20013]
- Updated dependencies [07f7ce1]
- Updated dependencies [1d12038]
- Updated dependencies [0703465]
- Updated dependencies [1898cd6]
- Updated dependencies [bb36c9b]
- Updated dependencies [1abe5bf]
- Updated dependencies [f148a18]
- Updated dependencies [f25d264]
- Updated dependencies [ee46048]
- Updated dependencies [6e9a63e]
- Updated dependencies [c71c849]
- Updated dependencies [9f7cb16]
- Updated dependencies [91aa42d]
- Updated dependencies [c71c849]
- Updated dependencies [5b68b6c]
  - @openbrf/i18n@0.1.0
  - @openbrf/shared@0.1.0
  - @openbrf/plugin-sdk@1.0.0
  - @openbrf/theme-tools@1.0.0
  - @openbrf/tokens@1.0.0
