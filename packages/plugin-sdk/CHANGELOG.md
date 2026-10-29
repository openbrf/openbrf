# @openbrf/plugin-sdk

## 1.6.0

### Minor Changes

- ee8a063: `host.audit.record` takes the request one of the plugin's device routes
  received. The entry has no actor, since a device names nobody, and each device
  spends a budget of its own with the plugin: a burst of 30, refilling at 30 a
  minute (`PLUGIN_AUDIT_LIMITS.perDevicePerMinute`). The entry past it is refused
  with `PluginAuditRateError`, nothing is written, and the plugin keeps running.
  Before this, a device's request was refused, and a plugin auditing on a device
  route could only write an entry with no request: every call the device made then
  spent the plugin's own budget, and whoever held a device's token could stop the
  plugin for everyone by calling the route fast enough. A device's request whose
  response has been sent is refused, as a person's is. The contract now says not
  to write an entry with no request for each call a route answers.
  `host.devices.current` now returns a frozen summary, so a plugin cannot change
  the token id that names the device's budget.
- 3c3c232: `host.audit.record` now limits how fast a plugin writes audit entries, with two
  token budgets that each hold a burst and refill continuously; an entry refused
  for its fields or its subject spends from neither. Entries on one person's
  requests share a burst of 30 with each plugin, refilling at 30 a minute
  (`PLUGIN_AUDIT_LIMITS.perPersonPerMinute`). The entry past it is refused with
  the new `PluginAuditRateError`, nothing is written, and the plugin keeps
  running, so no member can stop a plugin for everyone by making it audit them.
  Entries with no request, from the plugin's own jobs, share a burst of 120,
  refilling at 120 a minute (`PLUGIN_AUDIT_LIMITS.perMinute`). A plugin that
  writes past that is stopped with the new finding `audit-rate-exceeded`: the
  entry is refused and nothing is written, and every host service refuses the
  plugin until the application restarts, which switching the plugin off and on
  again does. The admin screen says why it stopped. Before this, a plugin writing
  in a loop could grow the audit log without bound, since an entry needs no
  permission and no purge removes it.

  The data subject access report now prints a plugin's text for an event as the
  plugin wrote it, with no interpolation or nesting, and cuts it at 200
  characters. A `$t()` in that text could otherwise print the core's words, or
  another plugin's, as the plugin's own.

  The record of processing activities now says when a plugin's row names no
  personal data: this record lists no categories, which does not mean the plugin
  handles none. Before, the list was empty, which read as a processing of no
  personal data at all.

- f17ccc2: A plugin whose view is for the residents can now declare a second view for the
  board, `boardView`, with its own module, its own title and the capability the
  board's routes behind it require (ADR 0051, amended). The board's page stands
  under `/board/plugin/<id>`, among the board's pages, with the board's sign on
  its heading and the sentence saying who sees it, and its entry stands in the
  board's section only. It is offered to a board seat that holds the declared
  capability and the floor of the plugin's routes. Anybody else who opens its
  address reads the sentence every refused board page says, and the plugin's
  module is not loaded for them. Opening it ends the resident preview, and no
  preview offers it. `GET /api/plugin-views` answers each view's `boardView`,
  with whether the account is offered it.

  The manifest refuses a board view with no view beside it, beside a view in the
  board's section or one that names no section, in a section other than the
  board's, with the view's own module, or in a plugin that reads the address book
  or the finances and declares no resident routes, whose view is the board's
  already. `@openbrf/plugin-sdk` exports `pluginBoardViewSchema`, the
  `PluginBoardView` type and `boardViewRuleIssues`. A manifest with one view is
  read and offered as before.

- 0ca24bf: An addon that reads contact details or the finances, proposes imports or
  declares personal data beyond names, apartments, residency, published text and
  pictures no longer serves beside a plugin with device routes, such as digital
  signage.
  A point on such a plugin accepts no contact details, but only the addon's own
  declaration said what it handed over: it could answer with a phone number, or
  what a household was charged, in any text field, and a screen in the stairwell
  would show it. The plugins joined by extension points are now read as one group
  for this as they are for the website (ADR 0052). Where a group would hold a
  plugin with device routes and one that reads or declares what a device may not
  show, the loader refuses addons until it does not, the one that reads or
  declares it first where the other is the host plugin, with the new finding `extension-device-group-refused`. The catalog refuses an
  index that would form such a group. An addon that reads only names and apartments still
  extends signage. One installed beside signage before this change is refused at
  the next start, and the installed plugins screen says why.

  `@openbrf/plugin-sdk` exports `extensionGroupRuleRefusals`, which reads both
  rules on a group, the website rule and the device rule, from members that also
  name their `deviceRoutes`, and names the rule each refusal breaks in its
  `reason`. `extensionGroupRefusals` keeps its arguments and its answer, and reads
  the website rule alone.

- 5b92b33: A host plugin that holds no register permission is now held to the board when
  one of its addons reads the address book or the finances. An addon can hand
  its host plugin a name or a contact in a point's output, and the host plugin
  can pass it on to its other addons. Before this change the host plugin's routes
  and actions stayed open to every account, the property manager and former
  residents included. Every plugin joined by extension points now has its routes
  and actions held to the capability floor of the whole group's permissions
  (ADR 0052), and its view is offered in the navigation on that floor. Installing
  an addon that reads the register can therefore take a host plugin, and that
  host plugin's other addons, out of residents' reach.

  `@openbrf/plugin-sdk` exports `extensionGroups`, the groups of plugins joined
  by extensions that the group rule reads, and its `ExtensionGroupMember` type.

- 90c0f3f: A plugin can now read who the instance is from `host.instance.read()`: the
  association's name, as the board wrote it in the settings, and the instance's
  public origin from the operator's configuration. A plugin that introduces the
  instance to a screen or a service outside no longer has to ask the board for
  either, or trust the headers of a request. It needs no permission, since
  neither value is personal data and both are public already. The SDK types
  `instance` as optional, so a plugin checks for it before use: an older instance
  does not have it.
- 27ced5d: A plugin's compare-and-set on a record about a person can now name the record
  as well as its revision (ADR 0047).

  A record's revision starts again from 1 when its key is written anew, after a
  delete or after the host erased the record on its erase date or on a granted
  erasure request. A write over a revision read before that could land on a
  record written since that had reached the same revision. Each record that
  `host.personRecords` returns now carries an opaque `identity`, which stays the
  same on every write over the record, a write a legal hold sets aside included,
  and is new for a record written anew. `put` and `delete` accept it as
  `expectedIdentity`, beside `expectedRevision` or on its own, and refuse a
  different record with `PluginRecordConflictError`. A write without it is
  checked as before.

- 6ca60db: A plugin's record about a person can no longer name somebody else, and what a
  legal hold keeps of a plugin's records has a bound (ADR 0047).

  - `host.personRecords.put` refuses a record whose key, property names or text
    values hold the id of any person in the register other than the record's
    subject, with the new `PluginRecordOtherPersonError`. The person's access
    report prints the record in full, so it must not tell them about anybody
    else. An id is found on its own or set off by other characters, as in
    `offer:<id>`, and one joined with `-` or `_` is found too. An id that is
    encoded or reversed is not, and is left to catalog review. Every person
    counts the same, so the refusal tells the plugin only that a string is
    somebody's id.
  - While a legal hold or a restriction stands, a record the plugin overwrites
    or deletes is set aside at most once a day: the version the day's first
    write replaced is kept, and later writes that day act in place. A plugin
    that rewrites a held person's record on every request no longer adds a row
    each time. The plugin sees the same revision, limits and answer as before.

- 2986a27: The SDK exports `PluginRequestContextError` and `PLUGIN_REQUEST_MEMBERS`. A host
  raises the error when a plugin gives one of the members that take a request a
  request that the work making the call is not serving: `addressBook.caller`,
  `actions.list`, `invoke`, `propose` and `client`, `audit.record` with a
  request, `themes.install`, and `devices.issue`, `revoke` with a request, and
  `current`. On a resident route, `addressBook.caller`, `actions.list`, `invoke`,
  `propose` and `client`, `audit.record` and `themes.install` refuse with
  `PluginResidentRouteError` instead, and the other members refuse with
  `PluginRequestContextError` there too. The
  error carries the plugin's id and the member, and its message names neither the
  request nor a person. The `PluginHost` documentation states the rule. The README and the documentation of `PLUGIN_API_VERSION` now state
  the one case in which a change a plugin can notice keeps the API version: a
  security fix that only refuses a use of the host beyond what the contract
  grants, where raising the version would refuse to load every plugin built
  against it.
- 3f7a104: The board now consents to a plugin's resident routes (ADR 0051), and the host
  serves a resident route only where it has.

  - **The consent screen** lists a plugin's resident routes beside its
    permissions, in Swedish and English: that any resident the address book
    lists to the plugin can use them without a board seat, each route's title
    opening to its address, that the plugin can tell which resident is asking
    and read and write its records about people there, other residents' records
    included, that it cannot read the register there, and that what it shows a
    resident of other residents' records is the plugin's choice. The titles are
    the catalog's, read from `residentRoutes` in a version 3 index entry.
  - **`openbrf plugin add`** prints the same section, each title with its
    address, before it installs, and echoes the routes it printed.
  - **The install records** the paths of the resident routes the board
    consented to, from the consent screen and from `openbrf plugin add` alike,
    and the install's audit entry names them. The install request echoes the
    routes with their titles, and an entry whose routes changed since the screen
    was drawn is refused as a consent mismatch.
  - **A new finding, `resident-routes-widened`.** A version that declares a
    resident route the board has not consented to, or moves one to cover a path
    it did not cover, is not loaded until the board installs it again. A route
    inside a consented one, or a route dropped, loads. A plugin installed before
    this release consented to none, so one that declares resident routes is
    refused until the board installs it again.
  - **The navigation** offers the view of a plugin with resident routes, in the
    section it names, to an account that holds a residency today, and to nobody
    else: a resident without a board seat is offered it, and a board member or
    administrator who does not live in the house is not. A plugin without
    resident routes is offered on its routes' floor as before.

  An instance with `OPENBRF_CATALOG_URL` empty reads the curated catalog at its
  version 3 address, which lists a plugin's resident routes, so it needs no
  configuration change. An instance that wrote the version 2 address into
  `OPENBRF_CATALOG_URL` cannot be offered a plugin with resident routes, and the
  address is not the curated one: empty the variable.

- 1965732: A plugin manifest can now declare `residentRoutes`: paths under the plugin's
  own mount that a resident may call without a board seat, although the plugin
  reads the register (ADR 0051). Each route has a `path`, written as a device
  route's is, and a `titleKey` in the plugin's own namespace. A plugin declares
  at most eight, and no two may overlap.

  The manifest refuses the declaration unless the plugin asks for
  `addressBook:read` or `addressBook:readContact`. It also refuses it beside
  `finances:read` or `finances:recordDelivery`, beside a view in the `board`
  section, beside an extension point, and on a path that overlaps
  `oauthProtectedResource`. The manifest and the catalog index share these rules
  through one function, `residentRouteRuleIssues`, and each applies the ones it
  has the data for. A catalog entry carries no view, so the rule on the `board`
  section is checked through the package's manifest, not the index.

  The catalog index carries the routes in a new version 3, each with its path and
  the curator's title in Swedish and English. Version 2 shipped in a core release
  that reads it strictly, so the field could not join it. Versions 1 and 2 refuse
  the field.

  The SDK also exports the `PluginResidentRoute` type and
  `PluginResidentRouteError`. A host that implements resident routes raises the
  error when a resident route reads the register, or when it passes `caller`, an
  action dispatch (`actions.list`, `invoke` or `propose`) or `audit.record` a
  request other than the one it is serving, and the same for `actions.client`
  and `themes.install`. It raises it with `outside` set when the plugin makes
  one of those calls, a `personRecords.put` or a `recipients.fetch` naming
  persons outside its resident routes, and a resident route that was already
  being served does not answer in time, or has not stopped working within a
  bounded overrun after its deadline. `caller`, an action dispatch, a theme
  install or `audit.record` without a subject that passes the very request the
  board or device route it is made on is serving neither waits nor is refused. `actions.client` is the other exception: made outside a resident
  route it neither waits nor is refused for a route that has yet to answer, as
  it only checks the route it is called in. On a resident route,
  `recipients.fetch` gives up in time for the handler to answer before its
  deadline, whatever its `timeoutMs` says, and fails with `unreachable`.

  This release only declares the routes. A host that does not yet implement
  them keeps every route at the plugin's capability floor, and does not offer
  the plugin's view to residents.

- 777d6c4: Refuse a website plugin that declares personal data about the members.

  A plugin may call the actions whose personal data its manifest declares, and
  some actions, such as `motion_queue_list` and the news comment actions, return
  members' names to a board member using the plugin's route. A plugin that asks
  for `site:blocks` and declared `name` could therefore receive names and print
  them in a public block, without any permission that reads the register.

  - A manifest or catalog entry that asks for `site:blocks` may now declare only
    `freeText` and `photograph`. Any other category fails validation with the new
    rule `blocks-declare-member-data`. An installed website plugin whose manifest
    declares another category stops loading until a version without it is
    installed.
  - Plugins joined by extensions now treat a plugin that declares any category
    other than those two as reaching the members' details, the same as one that
    reads the register or proposes imports. Such an addon is refused with
    `extension-group-refused` when it would share a group with a website plugin.
    `@openbrf/plugin-sdk`'s `extensionGroupRefusals` reads this from a new
    optional `personalData` field on `ExtensionGroupMember`. A member passed
    without it is read as declaring nothing, so a caller that passes only `id`,
    `permissions` and `extends` compiles and gets the same answer as before. Pass
    each manifest's or catalog entry's `personalData` to get the loader's answer.
  - A plugin's action calls are now limited to the categories its loaded manifest
    declares, within what the board consented to. Before, they were limited only
    by the consent, which could still include a category a later version dropped.

  The plugin contract now also states that a plugin's view runs as the signed-in
  person and calls the core's routes as that person. None of these checks applies
  to those calls.

### Patch Changes

- 6b8edc2: Refuse the addon that joins two clean host plugins, not the addons serving them.

  Where the plugins joined by extensions would hold both a plugin that asks for
  `site:blocks` and one that reads the register or proposes imports, the website
  addons and then the addons that read the register or propose imports now give
  way only among their own host plugin and the addons that extend it alone. Then,
  across the whole group, the addons that join two of its plugins give way. Before,
  installing an addon that extended both a host plugin with a website addon and a
  host plugin with an addon that reads the register refused all three addons;
  now the loader refuses only the addon that joins them, with
  `extension-group-refused`, and the catalog likewise names it in a refused index.
  Host plugins are still never refused, and the result still does not depend on
  the order in which the packages are found.

## 1.5.0

### Minor Changes

- 5dd82d2: A plugin can now keep records about a person through `host.personRecords`
  (ADR 0047). Open BRF looks after those records the way it looks after its own
  bookings.

  A plugin declares each collection in its manifest under `personRecords`, with
  the personal-data categories it holds, how many days a record may be kept
  (at most 1 830) and the fields the data subject access report labels. A
  plugin that declares one also declares its `processing` and asks for
  `addressBook:read`. The install consent screen and `openbrf plugin add` name
  each collection with its categories and its bound, and the install refuses an
  entry that changed them in between. A
  republished version that adds a collection, holds more categories in one or
  keeps a record longer is not loaded until the board installs it again
  (`personal-data-widened`). The field is in version 2 of the catalog index.

  Every record names one person and the day it is erased, which must come after
  the day of the write. A new record may name only a resident the address book
  lists to the plugin on that day. The day of the write is the day the write
  runs, so a write that waited in the plugin's queue or for a lock past midnight
  is judged on the next day. A record about a person
  with protected personal data, under a restriction of processing, or objecting
  to the plugin's processing is hidden from the plugin. A moved-out person's
  records stay visible, so a plugin can tell from its own records that a person
  it keeps one about became one of these rather than moving out, though not
  which. Catalog review accepts a plugin only if its features need the records
  it keeps.

  - A record is gone from the plugin's view from the start of its erase date. A
    nightly job at 03:50 erases each record on its day, and erases every record
    about a person whose erasure request the board granted, without running the
    plugin's code. The request stays open until none is left.
  - A legal hold or a restriction stops both. While one stands, a record the
    plugin overwrites or deletes is set aside instead and kept, and so is a
    record past its erase date. Neither is visible to the plugin or counts
    towards its limits, so the plugin cannot tell from its records or its limits
    that a hold stands.
  - Removing a plugin deletes its records itself, rather than through the
    database, and sets aside the records a hold or a restriction keeps. The
    audit entry for the removal says how many it deleted and how many it set
    aside.
  - The data subject access report has a new section listing every record a
    plugin keeps about the person, set-aside ones and those of a removed plugin
    included. It is labelled from the plugin's own translations even when the
    plugin is switched off.
  - The portability export carries a record only where the plugin's processing
    rests on consent or the contract, and then only the fields the plugin marks
    as given by the person.

  A plugin's own records (`host.records`) now refuse a collection declared under
  `personRecords`.

  `host.addressBook.caller(request)` answers whether the person making a request
  is a resident the plugin may serve, without saying why when they are not.
  `host.audit.record` takes a `subject`, so an entry reaches the access report of
  the person it is about. Naming a subject needs `addressBook:read` or
  `addressBook:readContact`.

  The reference plugin in `fixtures/example-plugin` lets a resident note the days
  they are away, kept for 30 days after the last of them. Its manifest states
  that purpose, it refuses days beyond the collection's bound with a translated
  reason rather than a server error, and it keeps nothing on an instance without
  `host.personRecords`.

### Patch Changes

- 3e21a75: The explanations of why an extension is refused now say that a plugin reads the address book or the finances, or proposes imports, where they said it reads the register or proposes imports. A plugin that holds only the finances permission is no longer described as reading the register.

## 1.4.0

### Minor Changes

- 78b27c4: The display mode for screens (ADR 0050). A board member who manages the
  website opens the new display screen, names a screen, chooses what it shows -
  the news, the coming events, the notice of the next general meeting and free
  and busy times for bookable resources - and how, and is given a display link,
  once, as text and as a QR code. Opened in any browser on a screen in the
  building, the link shows those in a rotation, refreshed every minute, with no
  account and no sign-in. The choices are in the link and kept nowhere else; the
  link's device token is listed on the devices screen under "Display mode",
  where any board member who manages the website can revoke it, and the screen
  then says that its display link is no longer valid.

  A news item, and an event with all its dates, now has a "Show on screens" mark
  in its editor, off on every item until the board sets it. Only published items
  marked for screens are shown, and an item whose text names somebody in the
  register, or an apartment number, is left out, as on every device. Setting or
  clearing the mark is part of the item's own change in the audit log. Plugins
  read the mark as `onScreens` on `PluginNewsItem` and `PluginOccurrence`.

  The display link's token is a device token for the core's new display route,
  `/api/display/`, with no plugin: it is refused on every plugin's device route,
  and a plugin's token is refused there. Issuing and revoking one are
  recorded in the audit log without a plugin. The screen content the route
  serves is the contract in `docs/screen-content-contract.md`, which moved there
  from ADR 0034, and the display page is built from the new `@openbrf/display` package.

  The migration makes a device token's plugin optional, held to the display route
  by a check, and adds the mark to news items and events, off on every existing
  row, in one transaction. It runs on its own when the instance starts.

### Patch Changes

- 8764168: Refuse an extension point that accepts `email` or `phone` on a plugin that
  declares device routes (ADR 0030).

  A device token reaches a plugin's routes, and a device is a screen on a wall, so
  a point that accepted contact details would let it reach them through an addon.
  The manifest is refused with the point's `personalData` named, and the catalog
  refuses an index entry that declares the same. A package skipped for it is
  reported under the rule `device-route-extension-point-contact`, which the
  interface reads in the board's language. A plugin without device routes, or with
  points that accept other categories, is read as before.

## 1.3.0

### Minor Changes

- 5d6ff4f: A picture a plugin opens with `host.media.open()` now says who it is for. The
  new `audience` is `anyone` for a picture held for anyone and `members` for one
  held for the members, the same words a news item and an occurrence use, so a
  plugin can keep a members' picture off a public page. The host still opens
  both, since it cannot know where the plugin shows the picture.
- 42d90f1: A plugin now states in its manifest, in a processing declaration, what its
  processing of personal data is for, and a person can object to one plugin's
  processing (ADR 0035).

  The manifest's new `processing` field holds that declaration: the purpose, the
  legal basis (and the legitimate interest relied on, where that is the basis), how long the data
  is kept and whether it concerns members, residents or both, in Swedish and
  English. The install consent screen and `openbrf plugin add` show it, a dry run
  included, and send it back with the install, which is refused if the catalog
  changed it in between, and the install writes it into the plugin's row in the
  record of processing activities in the association's language. Before, that row had the plugin's name as its purpose and no
  retention. The board's own edits to the row still win over a later version's
  text. A plugin that handles no personal data and does not read the address book
  no longer gets a row. The field is in version 2 of the catalog index, which an
  instance now reads beside version 1. The package check, and version 2 of the
  index, refuse a package that declares personal data without it, and one that
  asks to read the address book but declares no personal data.

  An objection recorded on a person's page can now name a plugin's processing
  instead of the association's mailings. When the board grants it, the person is
  left out of every read that plugin makes from the register until the objection
  is closed, and the plugin is not told. An objection to the mailings is
  unchanged and is a separate request.

  `host.addressBook.residents()` takes `{ addressId }` to read one entrance. Each
  resident carries `lastName` alone, and `nameInBuilding`, read from a new
  publication-consent scope for a name on screens inside the building. The board
  records that consent on the person's page like the others.

  `host.audit.record` lets a plugin write what it did to the audit log, as
  `PLUGIN_RECORDED`, with the person it acted for as the actor. The entry's
  `detail` keys are letters and digits, and a field holding a personal identity
  number is refused without the number in the error. The data subject
  access report prints the entry in the plugin's own words, and prints which
  processing an objection named and the new consent scope.

## 1.2.0

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
  preview and its row decisions as soon as it has been applied or has stopped,
  rather than keeping them until the upload expires. The record of a proposed
  import is kept for the 90 days described above.

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
  in one release, which the board installs, passes.

  A paid plugin installed before this release has no recorded consent to its
  issuer's keys, and is refused as `licence-widened` until the board installs it
  again from the catalog. A package refused over its issuer or keys keeps no
  manifest, even if it is also disabled or refused for another reason, so its keys
  verify no licence, on the licence screen or from the command line, and the admin
  screen draws no settings form for it.

- 417ebe4: Let a plugin read what the association has published: its news, its calendar
  and when its bookable resources are taken (ADR 0032).

  Three new permissions, each its own consent:

  - `news:read` gives `host.news.published()`: the published news items, newest
    first, with the title, the body's paragraphs, when each was published and
    whether it is for the members or for anyone. An item the board wrote to
    Styrelsen or Administratörer in the feed is not among them.
  - `calendar:read` gives `host.calendar.occurrences()`, the occurrences of
    published events in a window of at most 92 days, and
    `host.calendar.meetingNotices()`, the notices of the general meetings called
    and not yet held.
  - `bookings:readAvailability` gives `host.bookings.resources()` and
    `host.bookings.busy()`: the resources the house offers, and when each is
    taken in a window of at most 31 days.

  Nothing written about a person comes with them: no author, comment or read
  count on a news item, no sign-up on an occurrence (only how many places are
  left), no attendance or proxy on a meeting notice, and no booker, apartment or
  booking identifier on free/busy. Bookings that overlap or touch come back as one
  interval, so a run of slots cannot be read as one household's habits.

  The audience is on every news item and occurrence, and the host does not filter
  by it: whether a members' item may go where the plugin puts it is the plugin's
  declared purpose, and the board reads it on the consent screen, which states
  each permission in Swedish and English. A manifest asking for `news:read` or
  `calendar:read` must declare `freeText`, because the board's text may name
  anybody. None of the three raises the capability floor of the plugin's routes.

- 7a70a29: Let a plugin offer extension points and another plugin extend them (ADR 0030).

  A host plugin declares `extensionPoints` in its manifest, defines each point's
  input and output schemas with `host.extensions.define`, and calls the addons
  serving there with `host.extensions.list` and `host.extensions.invoke`. An addon
  declares `extends` and registers its handler with `host.extensions.contribute`.
  The host validates both directions against the host plugin's strict schemas and
  copies the values as JSON, and answers for what an addon does - not serving,
  timed out, failed, output invalid - in the result rather than by throwing. An
  answer longer than `EXTENSION_MAX_OUTPUT_LENGTH` as JSON is refused unparsed.
  A plugin that reads the register or proposes imports and one that asks for
  `site:blocks` do not extend each other, in either direction, and a website addon extends only a
  plugin that handles no personal data. Nor are the two joined through other
  plugins: where the plugins joined by extensions would hold both, the loader
  refuses the website addon (or, failing that, the addon that joins them) before
  its code runs, whatever order it finds the packages in, and the catalog refuses
  the index.

  Each addon is installed, consented to and switched on by itself, and never
  receives the host plugin's permissions. Its consent screen says what it extends
  and which personal data it hands over; the host plugin's says what its points
  accept. An addon whose host plugin is missing, switched off or removed does not
  serve, and the admin screen gives one of nine new findings
  (`extension-host-missing`, `extension-point-unknown`,
  `extension-version-unsupported`, `extension-personal-data-refused`,
  `extension-permission-refused`, `extension-host-personal-data-refused`,
  `extension-group-refused`, `extensions-widened`, `extension-refused`). The catalog index gains version 2,
  which carries both declarations; version 1 is still read. An index that lists an addon beside
  its host plugin is refused when the host's entry declares no such point, serves it at another
  version or does not accept what the addon's entry hands over; what the installed packages declare
  is still checked when the instance starts. Such a refusal, and those that hold an addon against the
  plugins it is joined to, carries the code of the matching finding, and `openbrf` prints it as a
  translated sentence above the catalog's own line.

  `PluginBlockAbortSignal` is now an alias of the new `PluginAbortSignal`.

- 417ebe4: Let a plugin open a stored picture and read the association's addresses
  (ADR 0032).

  Two new permissions, each its own consent:

  - `media:read` gives `host.media.open(mediaFileId)`: a picture's type, size,
    checksum and bytes, as a web stream. Only a picture held for anyone or for the
    members whose upload declared that it shows no identifiable person opens. A
    document, a household's or the board's file, a picture in the feed and a
    picture of people answer `null`, exactly as a file that does not exist. The
    name it was uploaded under is not handed over. A manifest asking for
    `media:read` must declare `photograph`.
  - `addresses:read` gives `host.addresses.list()`: each address's street and
    number, and never an apartment or anybody living there.

  The consent screen states both in Swedish and English. Neither raises the
  capability floor of the plugin's routes.

### Patch Changes

- 67a38b9: The import now refuses a member list saved without its row of column titles,
  when the first row holds a personal identity number, an email address, a phone
  number or a date. The import would otherwise have read that row as the titles:
  it would show a member's details as column names and store them with the
  upload. The upload is refused before any of the file is stored, and the board
  is asked to add a row of column titles and upload the file again.

  A file a plugin proposes is refused the same way, with the reason
  `header-row-missing`, which `IMPORT_PROPOSAL_REFUSAL_REASONS` now lists.

- 417ebe4: Keep published text that names a resident off every device (ADR 0032).

  For a plugin that declares a device route, `host.news`, `host.calendar` and
  `host.bookings` now run the register check on every read. A news item, an
  event, a meeting notice or a bookable resource is absent, whole, when one of
  its strings holds the name of a person the register holds (current or former,
  protected personal data included), one of their email addresses or phone
  numbers, or an apartment number. Names and apartment numbers match as whole
  words, ignoring case; a given name only where it begins with a capital letter,
  a name in the genitive as well, and an apartment number of one character only
  after a word for an apartment ("lgh 7"). A phone number matches by its digits
  however they are spaced or dashed. A withheld item looks the same as an
  unpublished one: a news read goes on to older items to make up the count, as
  far back as the newest 500 published items. `busy` starts no
  earlier than the moment of the call for such a plugin, so it shows no booking
  that has ended.

  The email addresses and phone numbers are looked up by their blind index, so
  the check decrypts nothing. A plugin without a device route reads exactly what
  it read before.

  The news, calendar, meeting notice and bookable resource editors mark an item
  that is withheld from devices and show the words that caused it, so that the
  board can rephrase it. A word that names only somebody with protected personal
  data is not shown: the editor says that the text names somebody in the
  register. The mark comes from its own read under each editor's capability. It
  is not an action, so no connected app reads it, and it is closed to support
  sessions. When a re-read after a save fails, the editor keeps the marks of its
  last answer for the same items instead of showing them as passing.

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

## 1.1.0

### Minor Changes

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

- 6d05800: A plugin's controller can now raise a route above its capability floor with
  `RequireCapability`, exported from `@openbrf/plugin-sdk` with the metadata key
  it writes (`REQUIRED_CAPABILITIES_KEY`) and the capability names a route may
  require (`PLUGIN_ROUTE_CAPABILITIES`, `PluginRouteCapability`). Before this a
  plugin had to set the key itself with `SetMetadata`. The API's own decorator is
  the same one, so the two cannot disagree on the key.
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

### Patch Changes

- 1358fa3: A plugin that declares a device route or a website block is now kept away from
  every permission that reads the register, including one added later: each
  permission is classified as reading it or not, and both rules follow the
  classification instead of a list of the refused.

  When a package is skipped because a device route or a website block sits beside
  a permission that reads the register, or because a device route overlaps the
  OAuth protected resource, the admin screen now words the reason in Swedish
  instead of showing the schema's English line.

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

## 1.0.0

### Major Changes

- 24ed1a8: Publish the plugin SDK, the theme tools and the design tokens publicly on
  npmjs.com, with a provenance attestation. A plugin or theme author outside the
  organization can now install the contract they write against, and run in their
  own CI the same package checks the core runs at install time. Each package
  carries the AGPL and the Open BRF Module Exception, which is what lets a module
  be licensed on its author's own terms.

  The first release is 1.0.0 for all three. The plugin SDK's major version is the
  plugin API version, and the theme tools' and the tokens' major version is the
  token contract's, so a major tells an author which hosts a package works with.

### Minor Changes

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

- 25552fb: Export `parseSha512`, `formatSha512` and `IntegrityError` from the plugin SDK.

  The instance reads a catalog entry's sha512 digest with them, so the catalog's
  own check can accept exactly the spellings the instance accepts, instead of a
  copy that drifts. The SDK reads a digest into a `Uint8Array` without `Buffer`
  or `node:crypto`, so it still bundles into the browser, where neither exists.
  Hashing and the constant-time comparison stay in the API.

### Patch Changes

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

- cb30f23: `pluginPackageProblems` reads the require calls in a server bundle correctly
  in more cases.

  A method or accessor named `require`, as in `{ require(name) { ... } }` or
  `this.#require(name)`, is no longer reported as a require whose target is not a
  string literal. And a require is no longer missed when it comes after
  `a++ / b`, after a `++` or `--` that starts a new line, after a division
  following a name outside the Basic Multilingual Plane or a property
  named like a keyword, as in `o.of / 2`, after a comment,
  string or regular expression ended by CR, U+2028 or U+2029, or when it is
  written as `require?.(...)`, `module?.require(...)` or with an escaped letter
  in its name, such as `requ\u0069re`.

  A method whose default value holds a regular expression after `return`, as in
  `{ require(x = (() => { return /x/; })()) {} }`, is no longer reported either.
