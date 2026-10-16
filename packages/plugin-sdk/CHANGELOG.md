# @openbrf/plugin-sdk

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
