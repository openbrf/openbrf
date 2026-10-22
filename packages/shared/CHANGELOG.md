# @openbrf/shared

## 0.3.0

### Minor Changes

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
  upgrade, and the website's addresses stay the same.

  For API clients: a menu entry's `kind` is `PAGE` or `EXTERNAL`, and
  `generatedKey` is gone; an entry for a built-in page is a `PAGE` entry with the
  page's id, and every entry carries `membersOnly`, which a change that leaves
  it out keeps as it was. Every page carries `builtIn` (`NEWS`, `CALENDAR`,
  `BROKER_INFORMATION`, `REQUEST_ACCOUNT` or `null`). A built-in page takes a new
  title and nothing else: a body, another address, another status, the front
  page and a delete are refused with `built-in`. The `menu_generated_keys`
  action is retired; `page_list` finds the built-in pages. ADR 0027 records the
  model.

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

- 4135ce7: A plugin can now read the association's fee notices and charges, record where
  it delivered one, and hear when one is issued or changed, through
  `host.finances`. This is the free part of advanced finances: what carries a
  notice or a charge into an accounting system or a bankgiro file is a plugin's
  own work, and it now has a public API to do it on.

  - Reading the finances covers the fee notification runs and their notices and the
    charges to members, masked as the files the board hands over and further: a
    person with protected personal data, or whose processing is restricted, is
    never named to a plugin, and a withheld value is a `withheld` branch rather
    than an empty string. No read carries a personal identity number or any
    payment state.
  - A separate permission lets a plugin record a delivery receipt - the route, the time
    and the receiving system's reference - against a notice or a charge. It is
    never a paid flag, it is audited, and the board sees receipts beside each
    notice on screen; they are not printed and not in the file. A plugin's read
    withholds a receipt's reference wherever the row's names are withheld. The
    data subject access report lists a notice's or a charge's receipts beside it.
  - `host.finances.events` delivers `feeNotification.issued` and
    `memberCharge.recorded`, `corrected` and `removed`, versioned per type and
    enqueued in the same transaction as the act. An event queued when the board
    switches the plugin off is dropped, not retried.

  A plugin route reading the finances requires both the fee and the member charge
  management rights. The plugin consent screen names the two permissions and the
  financial personal-data category a plugin reading charges declares. A manifest
  may not ask to read the finances beside publishing website blocks, as it may not
  ask for the address book there: a notice names the people it is for, and a
  website block is published to anybody. `host.finances` is feature-detected; the
  contract version stays 1. `docs/plugin-contract.md` now also says plainly that a
  plugin setting is no place for a credential.

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
  Nyheter, whose newest items are on the overview.

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

- 6d05800: A plugin's controller can now raise a route above its capability floor with
  `RequireCapability`, exported from `@openbrf/plugin-sdk` with the metadata key
  it writes (`REQUIRED_CAPABILITIES_KEY`) and the capability names a route may
  require (`PLUGIN_ROUTE_CAPABILITIES`, `PluginRouteCapability`). Before this a
  plugin had to set the key itself with `SetMetadata`. The API's own decorator is
  the same one, so the two cannot disagree on the key.
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

### Patch Changes

- f408d9d: The address book's search field now stops at the 200 characters the search accepts. A longer search was refused, and the address book then showed its failed state without the search field, so the only way out was to reload the page. The limit is shared as `MAX_ADDRESS_BOOK_SEARCH_LENGTH` in `@openbrf/shared`.
- f408d9d: An apartment number ending in "00", such as "1000", no longer has a floor read out of it. No apartment on a landing is number zero, so the number does not follow the Lantmäteriet convention, and it is now stored with no floor instead of being listed under the entrance floor. The correction applies to apartments added from now on: a row written earlier keeps the floor it was stored with, and the board can remove an unused one and add it again to have it recorded without one.
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

- f408d9d: The data-subject request forms and the breach decision and notification forms no longer answer a refused field with "could not be saved just now": they name the field the server did not accept, and they no longer send a request without its date or ground, or a decision without its ground. The grounds are held to the lengths the server accepts. A breach that was closed or removed in the meantime, or a notification recorded before the decision, now says so instead of falling back to "could not be saved".
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

- 933e778: Find a personal identity number written with an en dash, an em dash, a minus
  sign or another Unicode hyphen between the date and the last four digits, as a
  word processor sets `811228 - 9874`. Only the scan of free text accepts them;
  the parser a stored number goes through is unchanged, so no blind index moves.
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

- a41bd1c: The issue report's place and description limits (200 and 4000 characters) are
  now one definition in `@openbrf/shared`, used by both the API and the report
  form, so the form and the server cannot drift apart.
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

- f408d9d: Changing a password to one longer than the 128 characters signing in accepts now says the new password is too long, where before it said the current password did not match. The password forms stop at 128 characters, and first-boot setup refuses a longer administrator password instead of storing one that could never sign in. The limit is shared as `MAX_PASSWORD_LENGTH` in `@openbrf/shared` and set on the sign-in library.
- 26c5236: A personal identity number written with its century is refused when the
  century is not 18, 19 or 20, or when the birth date lies in the future. The
  person form and the import refuse it as not valid. A twelve-digit invoice or
  OCR reference whose last ten digits happen to form a valid number is no longer
  reported as a personal identity number, so it no longer stops the text it is in
  from being published.

  This is a check of what is entered. A number already stored keeps its index,
  and is found as before.

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

- f408d9d: The lengths the housing cooperative's name, the bankgiro and plusgiro numbers and the SMS sender name may have are now shared between the settings forms and the server that enforces them (`HOUSING_COOPERATIVE_LIMITS`, `FINANCE_LIMITS` and `SMS_LIMITS` in `@openbrf/shared`), like the other settings lengths. No limit changes.
- f408d9d: The lengths the address, apartment, issue type and bookable resource forms and the first-boot administrator form allow, and the shortest password an account may have, are now shared between the forms and the server that enforces them (`ADDRESS_LIMITS`, `BOOKABLE_RESOURCE_LIMITS`, `ISSUE_TYPE_LIMITS`, `ADMINISTRATOR_LIMITS` and `MIN_PASSWORD_LENGTH` in `@openbrf/shared`), so the two cannot drift apart. No limit changes.
- 0703465: Harden how the API reads a calendar date.

  Every endpoint that takes a "YYYY-MM-DD" date now refuses one the calendar does
  not have, such as the 30th of February or a 13th month, with a 400 rather than
  reading it as a different day. Moves, lien notes and positions of trust also
  refuse it in the service, and a member list import checks the move-in date
  chosen for the whole file as it checks the date in a row.

  A lien note cannot be dated or released on a day that has not arrived, and a
  release cannot be dated before the note it releases.
