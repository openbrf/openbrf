# @openbrf/plugin-sdk

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
