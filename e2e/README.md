# End-to-end tests

The suite drives a browser against the production stack: the image built from
this repository's `Dockerfile`, started through `docker-compose.prod.yml` with
the overlay in `docker-compose.e2e.yml`, from empty volumes. The production file
runs a published release; the overlay is what builds this checkout instead.

That is the point of it. Several of the properties under test only exist in the
deployed artefact - the entrypoint provisioning the field encryption key, the
application connecting as a database role that cannot rewrite the statutory
registers, the API serving the built client from one origin so the session
cookie survives. A dev server would prove none of them.

## Running it

```sh
pnpm install
pnpm --filter @openbrf/e2e browsers   # once: downloads Chromium
pnpm test:e2e
```

Docker has to be running. The first run builds the image, which takes a few
minutes; later runs reuse the layer cache. The stack listens on
`localhost:3010`, its database on `5442` and its mail server on `8125`, so it
never collides with a development database on 5432 or an application on 3000.

The suite imports `@openbrf/shared`, so the package has to be built.
`pnpm test:e2e` builds it first. To run `playwright test` directly from `e2e/`,
build it once with `pnpm --filter @openbrf/shared build`.

Starting the stack pulls its registry images first. A pull the registry
throttles, or that fails on the way there, is attempted up to four times in all,
with a growing pause between attempts; one that cannot succeed - a missing digest, a refused pull, a
compose file that does not parse - fails the run at once. That decision lives
in `src/image-pull.ts` and is tested without Docker by the workspace's Vitest
tests (`src/*.test.ts`), which `pnpm test` runs with the rest of the monorepo.

On your machine the stack pulls the images its files pin. CI sets
`OPENBRF_IMAGE_MIRROR`, and the suite then adds an overlay of its own that pulls
PostgreSQL, and hands the build the Dockerfile's base image, from CI's copies in
the GitHub Container Registry: the same digests, from a registry that does not
meter CI's pulls (`scripts/ci-images.mjs`).

While writing a spec:

- `OPENBRF_E2E_REUSE_STACK=true` runs against a stack that is already up and
  skips the rebuild. It also skips the fresh volumes, so `01-first-boot` will
  fail; use it with `--grep` on a later spec. The first test in
  `03-invitations` fails on a reused instance too, and has to: an invitation
  activates an account for a person who has none, and the two it invites got
  theirs on the run before. The rest re-runs without colliding, because a
  person a spec makes for itself takes their name and email address from the
  run that made them (`src/identity.ts`), and an apartment a spec moves
  somebody into is claimed for the run that claimed it (`src/apartments.ts`).
  A personal identity number comes from the run only where the spec asks
  `uniquePersonalIdentityNumber` for it: `06-protected-personal-data` and
  `09-statutory-registers` still write a fixed one, so each reused run stores
  another person holding the same number.
- `OPENBRF_E2E_KEEP_STACK=true` leaves the stack running afterwards, so a
  failing instance can be looked at.

Whichever way it ends, a run writes the deploy steps' and the application's
logs to `test-results/app.log` at the repository root before the stack is
removed, so a failure the server caused can be read after the containers are
gone. The screenshot task does the same.

Re-running is not the same as leaving nothing behind. Nothing here deletes a
person, an account, a member-register entry or an audit entry: the register and
the log are append-only by design, and no endpoint removes an account. Every
reused run therefore adds another set of them, personal identity numbers and
phone numbers included, because `06-protected-personal-data` needs data worth
masking. Fresh volumes are what clears that, which is why reuse belongs on a
throwaway development stack and nowhere near an instance holding anything real.

What a spec can take back, it takes back. `02` removes the passkey and the
authenticator app it enrolled from the shared administrator account in a
`finally`, so a run that fails part way through does not leave a second factor
on the account the later specs sign in as.

## How it is put together

- `src/stack.ts` owns the compose invocation and reads `stack.env`, so the
  suite and the stack cannot drift apart. It knows two stacks: this one, and the
  screenshot task's, selected with `OPENBRF_E2E_PROFILE=screenshots`. Before
  either starts it writes the fixture catalog into a directory of its own under
  the system's temporary directory, which the overlay mounts read-only at
  `/catalog`.
  The sign-in secret is not in either env file: the application refuses a
  published one in production, so `src/stack.ts` generates one for every run and
  passes it to Compose in the environment.
- `src/plugins.ts` drives the plugin system from outside the instance. An
  install or a removal ends with the server exiting for the supervisor to start
  it again, and the process on its way out still answers a health check, so
  `waitForRestart` asks Docker when the container's current process started as
  well as asking that process whether it is serving. `cli` runs the command-line
  tool in a container of its own through the entrypoint, which is what hands it
  the runtime database URL, the way an operator runs it beside a running
  server.
- `pg-boss` is a dependency here, pinned to the exact version the API uses.
  `90-runtime-role-privileges` drives the queue the way the application does,
  and a different version would prove something about a different client.
- `src/provision.ts` builds the instance every spec after the first one expects,
  idempotently and over HTTP. The first-boot spec builds the same instance
  through the wizard, screen by screen, because that is what it is testing.
- **An `ensure*` helper returns early only on evidence of the finished state.**
  Every one of them does several writes, and only the first creates the person:
  the sign-up approval that follows records the residency, the move-in that
  follows records the tenant-ownership. A run that failed between them leaves a
  person behind with none of it, and a helper that asked only "does this name
  exist" would return early on that wreckage from then on - what fails is an
  assertion several tests later, timing out on a screen that is empty for a
  reason nothing reports. `api.findPersonByName` answers with the whole address
  book row, which carries the apartment and the move-in date, so the check
  costs no second request; `api.findPersonIdByName` is that function with the
  row thrown away, for callers who need the id alone.
- `src/apartments.ts` adds an apartment to the register and hands it to the
  spec that asked for one. A residency, a transfer and a member register entry
  are all kept for good, so a spec naming a fixed apartment describes an
  apartment somebody already holds on its second run against one database - and
  the first grant it asserts has already been recorded. The apartment is added
  rather than looked for because a number the register does not hold yet cannot
  have a resident, which a list read a moment ago does not promise.
- `src/mailpit.ts` reads the mail the instance really sent. Invitations and
  sign-in links exist only as email, so there is no other way to check them.
- `src/totp.ts` is RFC 6238 in twenty lines, standing in for an authenticator
  app.
- `src/database.ts` reads the audit log and the statutory member register
  directly. Neither answers the question "what was written" over HTTP - the log
  is evidence rather than a feature, and the register is only ever served as an
  extract - so a reveal, a member register extract and an entry written by a
  move-in or an import are checked against the rows themselves.
- `src/xlsx.ts` builds a real .xlsx workbook in memory, so the import's upload
  control is exercised with a workbook rather than with a binary fixture nobody
  can read in a diff.
- `src/fixtures.ts` gives each test its own client address. Better Auth counts
  its endpoints per client and per path and identifies the client by
  `X-Forwarded-For`, and a sign-in attempt is counted tightly because guessing a
  password is what that budget is for; without this the suite would spend one
  test's attempts on another's and throttle itself. A test where two people act
  asks it for a second address as well, for the same reason: an applicant
  activating an account really is somewhere else from the board member who
  approved their request.

Specs run serially, in file-name order. `01-first-boot` needs an unclaimed
instance, which an instance is exactly once, and the rest share the instance it
leaves behind rather than each paying for a stack of their own. The stack sets
no setup link digest, so the instance prints its setup link to its log when it
starts, and whatever claims it - the walk in `01-first-boot`, or
`ensureInstance` when a run starts later in the list - reads the link from
there (`claimLinkFromLog` in `src/stack.ts`).

## What is covered

Numbered against the phase 1 exit criteria.

| #   | Criterion                                                                                                                                           | Spec                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | First boot serves the wizard; completing it creates the housing cooperative, its addresses, its apartments, the email settings and the first admin  | `01-first-boot.spec.ts`                  |
| 2   | Password sign-in, passkey and authenticator app enrolled, sign out, sign in with each                                                               | `02-sign-in-and-second-factors.spec.ts`  |
| 3   | A member, a resident on the same apartment and an external board member with no apartment are invited, activate and sign in; sign-in link by email  | `03-invitations-and-magic-link.spec.ts`  |
| 4   | Self-signup with the toggle on, board approval, activation; the endpoint closed with the toggle off                                                 | `04-self-signup.spec.ts`                 |
| 5   | The address book: house tabs, floor grouping, filter tabs, signs, legend, register stamp, light and dark and follow-the-system                      | `05-address-book.spec.ts`                |
| 6   | Protected personal data stays masked, reveals are explicit and audited, and a neighbour does not see the person at all                              | `06-protected-personal-data.spec.ts`     |
| 7   | A member list imported: the columns mapped, every outcome previewed, the member register written, and the run found again after a reload            | `07-import-with-column-mapping.spec.ts`  |
| 8   | Move-in writes the member register and welcomes the person in their own language; move-out states the purge date and keeps the entry                | `08-move-in-and-move-out.spec.ts`        |
| 9   | The two statutory registers as separate documents, the printed extract, the audited full apartment register extract, and a tenant-owner's own entry | `09-statutory-registers.spec.ts`         |
| 10  | A plugin installed from the admin screen: declaration consented to, digest verified, restart, route, view, translations, settings; command line too | `47-installing-from-the-catalog.spec.ts` |
| 11  | The installing half: a theme installed from the admin screen without a restart, the install-time lint, the live preview and activation              | `47-installing-from-the-catalog.spec.ts` |

`47-installing-from-the-catalog.spec.ts` installs from a catalog and never
reaches the network. `src/stack.ts` runs `scripts/build-fixture-catalog.mjs`
before the stack starts, which packs the fixture plugin in
`fixtures/example-plugin/` and the fixture themes in `fixtures/themes/` and
writes one index listing all three beside them in a directory of the stack's own
under the system's temporary directory. The overlay mounts that directory at
`/catalog`, and `stack.env` points
`OPENBRF_CATALOG_URL` at the index inside it and opts the instance out of
curation, which a `file:` index and the `file:` tarballs it names both need.
Everything after the read is the path a curated instance takes: the entry
parsed, the tarball read and its digest checked before anything is unpacked,
npm in the runtime image installing the plugin onto the data volume, the
process exiting and the supervisor starting it again, and the built client
loading the plugin's view and its translations from the volume. The spec signs
in once, because a session survives a restart. It removes the plugin again
before the theme half, since the fixture declares the address connected apps
sign in to and only one installed plugin may hold it, and it leaves the built-in
theme active with the example theme removed. A failure part way through can
leave the plugin installed, so a red run is read from this spec's first failure
before any later spec's.

Some specs are not numbered against a criterion.

`90-runtime-role-privileges.spec.ts` connects as `openbrf_app` - the role the
migrate service created and constrained with
`apps/api/prisma/sql/harden-runtime-role.sql` - and checks both halves of that hardening:
the queue works (a queue is created, a job is sent and a worker receives it)
while the role creates nothing in either schema, not even a temporary table,
the statutory archive still refuses an `UPDATE`, and neither the migration
history nor the job schema's version can be written. It reads the database on
the port `docker-compose.e2e.yml` publishes, so it needs no browser.

Its last tests look at the application's container. One reads the environment
of every process in it - the init process, the server and the probe itself -
and fails if any of them holds the schema owner's or the superuser's password,
which the probe is handed on standard input rather than through anything it
would then find in its own environment; it also puts every connection URL the
server holds against the member register. One checks that nothing under `/app`
belongs to the user the application runs as, and that no file the deploy runs
can be written. And one starts the server with the owner's URL as its runtime
connection and expects it to refuse to serve.

`91-startup-and-connection-urls.spec.ts` covers what the image does with the
database password and with a request that belongs to nobody: the first-boot
check reports an unreachable database without writing the connection URL into
the startup log, a password carrying `:`, `/` and `@` survives the URLs the
entrypoint builds from it - which is why `stack.env` gives every role one - and
an unknown `/api` path answers the API's JSON 404 while a client route answers
with the client, query string or no query string. Since the client moved under
`/app`, it also holds the other half of that split: a traversal shape aimed at
the root meets the association's website and gets its not-found page rather than
the client's index.

`94-every-variable-in-every-service.spec.ts` starts a second stack beside the
suite's, from the same image and under a project of its own, the way a hosting
platform such as Coolify starts `docker-compose.prod.yml`: every service is
given every service's variables, through an override `src/shared-environment.ts`
writes from the rendered configuration, and the env file sets only what
`docs/deployment.md` has such an operator set, with no database password. The
application has to come up healthy, with neither the superuser's password nor
the schema owner's, both generated by the deploy, in its container's
environment or in any process running in it. A second `up` keeps both, and a
later boot that lost the superuser's password is refused rather than given a
new one the database would not take. The superuser then gets a new password
the way `docs/deployment.md` has an operator give it one, the stack starts with
it, and the old one no longer signs in. Its database logs every statement it is
sent, and none of the four passwords is in that log: the owner's and the
runtime role's are set as SCRAM verifiers (`docker/scram.mjs`). So are an
owner's and a runtime role's password an operator supplies, with characters
SASLprep changes, which psql then signs in with, and neither is in the log
either. It publishes no port and drives no browser.

`93-public-site.spec.ts` holds the public website to what it promises the people
who read it. No script runs on a page, no cookie is set on any response, every
request the browser makes goes to this instance - the typefaces above all, which
is the one that would silently become a third-party request - and a member-only
page is byte-identically the same not-found as an address with no page behind
it, while the same address opens for someone signed in. It writes its member
page through `src/site.ts`, which now uses the board's own endpoints, so the
page under test is one the publication guardrails have already passed.

`22-site-editing.spec.ts` drives the page editor. The board writes a page,
previews it, publishes it, and it is then read on the website by somebody with
no account; publishing is refused while the text carries a personal identity
number; and a claimed instance links its privacy notice from the footer of
every page. It is on the root-navigation allowlist in `93-public-site`, because
reading the published page on the website is the assertion.

`26-site-menu.spec.ts` drives the menu. The board builds a top level and one
level under it, moves an entry to the front and watches the website's front page
follow it, and the same website is then read twice: by a visitor with no
account, who is not told the members-only page exists, and by the board member's
own session, who is. The dropdown is opened with the keyboard rather than with a
pointer, because the site runs no script and focus is the only thing that opens
it. It is on the same allowlist, for the same reason as the one above: the menu
is chrome on the website itself.

`30-motions.spec.ts` drives motions to the general meeting, and its subject is a
statute about who a person is. The shared register fixture holds two people in
one apartment - Astrid Lindqvist as a member and Nils Lindqvist as a resident -
and EFL 6 kap. 15 §, applied to a housing cooperative by BRL 9 kap. 14 §, gives
only the member the right to have an item taken up at a general meeting. So she
submits one through the screen and takes it back, and he is offered neither the
destination in the navigation nor a form on the screen when he asks for it by
hand. The board then reads the item in its queue, records it as received, and is
offered no way to reject it, because refusing to take up a member's item is not
the board's decision to make. Last, the deadline: an administrator records the
clause the association's own bylaws carry and the member reads the resolved date
on the form she writes in, which is the only path by which that date can reach
her - the platform holds no default. The spec restores the deadline to none over
HTTP, so the shared instance is left as the specs after it expect.

`31-news-comments.spec.ts` drives the thread under a notice, and its subject is
one payload answered differently per reader. It takes the spec above from the
other side: Nils Lindqvist holds no tenant-ownership, and where that one offers
him no motion at all, this one offers him the comment box - `news:comment` is
granted by living in the building, and membership adds exactly one capability in
this platform. He writes a comment and reads it back off the thread. The board
then strikes it through and is offered no way to take that back; afterwards the
same comment reads three ways, and all three are asserted through the interface:
struck through with its text to the board, struck through with its text to its
author, and struck through with the text absent to the neighbour the server never
sent it to. That third reader is Karl Berg rather than the author's own
household, because `27-site-data-blocks` puts Astrid Lindqvist on the board to
photograph the roster block, and a board seat reads a struck comment by design,
so she cannot stand for the reader it is kept from. Last, a comment carrying a
personal identity number is refused, the refusal reaches the screen as a
sentence, and the sentence does not carry the number. The spec publishes a notice
of its own and asks for no mailing, so it leaves the mailbox alone.

`33-data-protection.spec.ts` drives what the association has to be able to show
as controller, and its subject is a set of clocks and refusals that only exist
against a real database. A breach recorded twelve hours after it was discovered
is inside the 72 hours of GDPR art. 33(1) and the strip says how many are left;
one discovered five days ago is over the bound the moment it is written up,
which is the ordinary case, and the decision on it will not save until the
reasons for the delay that paragraph requires are given - a refusal the board
reads as a sentence rather than as a field turning red. Every recipient of
personal data is then classified through the screen, the list coming from the
deployment rather than from the test, until the strip says there is nothing left
unanswered. The privacy notice gains the association's own contact details, and
a second browser context with no session at all loads `/integritetspolicy` and
reads them, which is the half that matters: art. 13 is owed to the person, not
to the board's screen. Last, an erasure is refused for a member who still lives
here, because the exception in art. 17(3) is the association's statutory duty to
keep the member register, and the same request is recorded as refused with that
ground; and the member herself takes her own data with her from her profile
under art. 20, in a file that carries what she gave the association under the
membership or a consent, and not the statutory registers, what rests on the
association's legitimate interest, the audit trail or her personal identity
number.

There is deliberately no path in it that records a breach through a screen,
because there is none to drive: a breach is discovered in a hurry, often away
from a desk, and the board writes it up afterwards. What the screen is for is
the two decisions art. 33 and art. 34 ask for, and those the spec drives by
clicking.

`35-board-mailbox.spec.ts` drives the board's shared mailbox, and it is the only
spec in this package that exercises mail in both directions. Mailpit stands in
for an association's mail provider twice over: the application relays through its
SMTP port as every other spec's mail does, and collects from its POP3 port, which
the overlay turns on with `MP_POP3_AUTH`. An inbound letter is put into the
mailbox through mailpit's own send API rather than through anything in the
product - the application has no test-only endpoint and gains none here - so what
is under test is the path a real letter takes: a message sitting in a mailbox and
an instance that collects it. Collection is driven from the board's own "collect
now" control rather than by waiting out the five-minute schedule, which is the
product's control and not this suite's. The spec then asserts the whole of the
round trip through the interface: the thread appears with the correspondent
the envelope named, a board member takes it on and the screen says who has it, the
answer is written and sent, and the answer arrives in mailpit as real mail. Three
properties follow it. Collecting the same mailbox again brings nothing in twice,
which is the unique identifier doing its work against a real constraint. A
resident is offered neither the destination nor the screen. And none of it
reaches the association's website, which is read as a visitor from the street
would read it - through the public surface rather than the application - so the
spec needs no place on the root-navigation allowlist in `93-public-site`. Last,
the access report answers for correspondence with a resident's own registered
address, which is the one place the platform goes from a person to a thread.

`36-action-registry.spec.ts` drives the first slice of the action registry, and
its subject is a refusal with no screen of its own. A connected app may write the
association's news and publish it, and it may not mail the members: the most it
can do is ask, and what an ask leaves behind is a notice on the board's own item.
What this spec drives is the board's own route and the catalogue, and the reason
is worth stating rather than leaving to be inferred: nothing in this build
carries a call from a connected app to the registry, because sign-in for MCP
clients is the change after this one. So dispatch itself - the capability check,
the arming, the refusals - is held by the unit and integration tests, and this
spec covers the half that needs a deployed instance.
The spec places the request over the API, reads the notice on the board's screen -
which says that something asked and never who, because the row the screen renders
from carries no person for it to name - dismisses it, places it again, and answers
it the only way there is, with the ordinary publish and the mailing where it
already stands. Two things follow that only a deployed instance can show: nothing
reaches a member's mailbox while the request stands, and exactly one message does
once the board has published, after which the item states in words that a news
item is mailed once and a further request is refused on those grounds. The other
half is the catalogue a connected app reads before it does anything.
`?surface=mcp` offers exactly the twenty-four first-slice names, each with its
text resolved into the association's own language rather than the key i18next
falls back to, and `page_update` publishes an input that refuses a key it does
not declare, requires the revision that was read, and carries no
`photoConsentConfirmed` anywhere: a consent attestation is a board member's
statement about the people in a photograph, and an input offering it would be
the platform inviting a caller to assert it on their behalf. The spec removes
the notice it wrote.

`37-mcp-sign-in.spec.ts` drives how a member points an external program at their
own instance, and it covers one half of that. The half is everything around the
token, which is the part that only exists once the image is serving one origin.
The discovery documents answer at the root of the origin, over HTTP, to a caller
holding no session: that is where a client has to find them and how it has to be
able to read them, before any token exists. The OpenID alias answers a refusal in
JSON, asserted against an unclaimed path beside it, because the association's own
website answers that path with a not-found page carrying the same status and only
one of the two is something a program can parse. A member then reads what they
have let act in their stead on their own settings screen and is refused the
association's list three times over - in the navigation, on the screen and by the
endpoint. The board reads that list, and the address its screen prints for
configuring an app is the one the resource document names; an elected seat reads
the same list and is offered no way to register a client, which is an
administrator's, so the two capabilities the screen is built around are held
apart where a person meets them. Last, the sign-in hop, which this change fixes
for every guarded route in the product: an address asked for without a session
travels to the sign-in screen and is returned to afterwards, and one naming
another host is refused so that signing in cannot end on somebody else's site.

The other half - a token presented on the resource route and accepted or refused
there - is not in this spec and cannot be. The resource is a connector plugin's
own route; no plugin is installed while this spec runs, so nothing declares one, and
with none declared the authorization guard's Bearer branch is never installed and
no path on the instance is Bearer-only. A test here against that branch would be
asserting about code the deployed image did not load.
`apps/api/src/plugins/plugin-http.int-spec.ts` covers it against a plugin that
really is installed and really does serve the route, and
`apps/api/src/connected-apps/connected-apps.int-spec.ts` covers resolving a
token against the audience, the expiry and a cut connection, the lists on both
sides, the disconnect and its audit entry, and what erasing a person takes with
them. The same limit is why both lists the spec reads are empty: connecting an
app takes a registered client and a signed authorization request, which is a
call rather than anything a person does at a browser.

`40-feed-board.spec.ts` drives the board's own audience in the feed
(Styrelsen, which the board chat became), and its subject is delivery. A post
written in one browser reaches a second browser that was never reloaded and
never navigated, which is the whole claim a poll makes and the one thing neither
the unit tests nor the integration suite can show: they hold the poll's
mechanics and what the endpoints answer, and neither of them has a second screen
open. It is asserted by waiting for the text, so it passes as soon as the first
poll after the write lands; waiting out the four-second interval instead would
be asserting the clock and would flake the day the machine was busy. The spec
also covers the half of the feature that is a refusal - somebody who lives here
is in Alla and not in Styrelsen, and the endpoint answers the board's audience
by identifier exactly as one that does not exist - the personal identity number
guardrail with the response read as well as the screen, and a feed longer than
one page, where the posts before the newest fifty are one press away rather than
quietly missing. The seats it needs are granted with `grantBoardSeat`, because
the shared fixture provisions people through the sign-up approval path and that
writes residencies and nothing else. The second board member the two-browser
test needs is created by the spec rather than borrowed: a person needs no
apartment, no residency and no membership to hold a seat.

`43-feed-groups.spec.ts` drives a group, and its subject is who may reach one.
A resident makes a group from the screen with nobody appointing it, picks a
neighbour out of the people who live here and puts them in, and the neighbour
finds the group on their own screen. Somebody who is not in it does not find it
on the list or in a search, and is answered for the group, for a post in it, for
that post's own address and for the image on it exactly as for something that
does not exist - the same status and the same body, asserted as an equality,
because anything that told them apart would let the identifier space be walked
to learn what groups the house has made. And the board's one way in: a member
reports a post, the board reads that post in its queue with the group named
beside it and nothing else of the group, strikes it through, and the group loses
the text while its author keeps it. That path crosses three sessions and two
capabilities, which is what makes it a test only a served instance can carry.
Every person in it is created by the spec, moved in through the ordinary move-in
path so that the residency a place in a group rests on is a real one.

`46-feed.spec.ts` drives the house's own use of the feed. A resident posts to
Alla through the composer with text and an image; a neighbour likes the post,
answers it in the thread under it and is counted as having read it, because it
was on their screen; the writer sees the count - never the names - and the post's
own address opens it with its comments, which is what a mailing or a report
links to. The search and the filter are driven on screen, and the chat's old
address is followed to the feed.

`47-feed-board-tools.spec.ts` drives the board's tools in the feed. A board
seat holder writes as "Styrelsen via" themselves, with a title, marked
important and pinned; the post is on top of the feed with the board's mark on
it, and the news screen's own endpoint answers it as a published news item with
its mailing claimed, because that a board post is a news item is the claim. A
neighbour reads it and is offered none of it: no "Från" in the composer, and the
endpoints refuse the board's options from them whatever a browser sends. A
scheduled post with comments turned off waits beside the feed under the
board's sign and in nobody else's feed, and the board answers under its post as
Styrelsen and takes the pin off with the control its sign marks. That a
scheduled post is published by its job, mailing and all, reaches the next poll
even when the job runs late, appears at once when a board member publishes it
by hand first, and is never published over such a publication or a take-down
is `apps/api/src/feed/board-post.int-spec.ts`: a browser would have to wait out
the instant. So is a post written as Styrelsen to Styrelsen or Administratörer,
which only that audience reads and is mailed: the walk photographs its
composer (`feed-board-composer`).

Deliberately not here: the administrator's own audience, Administratörer, as
an administrator without a seat reads it. Three earlier specs put the shared
administrator on the board and the grant is idempotent, so on this instance
they have a seat. `apps/api/src/feed/feed.int-spec.ts` covers that case against
people it builds itself, along with the refusal for an
audience somebody is not in being the same refusal as for one that does not
exist, the access report section, and the nightly purge with its legal hold.
`apps/api/src/feed/group.int-spec.ts` is the same for a group: a place in one
ending the day the residency does, the audit entries the three acts write, what
the access report says about a group and about what somebody reported, and the
purge erasing a group that has held nothing for a year along with the list of
who was in it.

`45-navigation.spec.ts` covers the navigation itself. The destinations are
grouped into four sections - Föreningen, Huset, Styrelsen and Inställningar -
and from 1024px the band carries one sign per section the account has anything
in, each opening its destinations under it; below that a bar carries three
destinations chosen for the account and Meny, whose sheet holds every section.
The spec checks that the administrator's band holds its three section signs and
Inställningar, the link to their own account at the band's end, and the whole
offer in band order without running off the header at 1280px and at 1024px, and
that the bar takes over one pixel narrower; that a section opens, closes on
Escape and on a press elsewhere, hands focus back to its sign, and marks itself
as where the reader is after one of its destinations is chosen; that the
settings are the person's own account at `/app/settings`, with no sections and
no sign, while the association's settings are the board's page under
`/app/board/settings`, signed on its heading, a route per section that the back
button walks; that a resident's phone carries Översikt, Ärenden and Bokningar,
that Meny's sheet lists every section and makes the room behind it inert until
it closes, and that the association's settings answer a resident as any board
page does; and that the property manager's band is exactly three links, the
issue queue standing as a sign of its own. It is the one spec that changes the window, because the switch
between the band and the bar is its subject; every other spec runs at the
suite's 1280px.

`46-overview.spec.ts` covers the overview, the page every sign-in lands on. A
resident places a key order and finds it under "Väntar på föreningen" with its
status and a link, beside their bookings, the next events and the news, and
nothing of the board's. A board member of the spec's own, with a seat and no
home here, gets one line led by the board's sign, saying how much is waiting
and linking to the board's front page; there each queue has a row whose count
is compared with what the queue's own endpoint answers at the same moment, and
the line's total with the rows' sum. The address book is reached from the
board's sign at `/app/board/address-book`. In both, every 403 the overview
draws is collected and must be none. Which panels each set of capabilities
gets, and the empty and failed states, are pinned down by the unit tests in
`apps/web/src/overview`.

`48-board-pages.spec.ts` covers one page, one audience (ADR 0049): every page
of the board's is under `/app/board`, and a house page carries no board half.
A board member of the spec's own opens the board's section in the band, reads
it grouped by the kind of work, and reaches the front page and the two pages
that replaced the house pages' board halves (issues and bookings), each with the
board's sign in its heading; the front page's rows lead to the queues, the
overview's line leads to the front page, and the house pages show that board member no sign and no
queue. A resident is offered no board section, and a board page opened by its
address says it is the board's and shows no sign. The property manager's one
board page is a sign of its own in the band and the middle of the phone bar.

Every other spec reads what an account is offered through
`src/navigation.ts`. A closed section renders no links, so an assertion that a
link is absent from the page would pass whatever the navigation offered.
`offeredDestinations` opens each section in turn and returns the whole offer,
and a spec polls it for a destination the account has before asserting that
another is absent from the same list; `goToDestination` presses a destination
the way a person reaches it.

`48-management-api.spec.ts` covers the management API (ADR 0021). The overlay
gives the app a management port and the digest of a token the spec holds, both
from `stack.env`, and publishes no host port for it, so the spec calls the
listener from inside the app container. It checks that the digest in
`stack.env` is the digest of the spec's token; that the summary names the
version in `apps/api/package.json`, says the instance is claimed, counts the
apartments and persons the database holds and has no migration pending or
failed; that every successful read writes an `INSTANCE_SUMMARY_READ` entry on the
`MANAGEMENT` channel with no actor; that a wrong token and none are refused
with `401`;
and that neither `/api/management/v1/summary` nor `/v1/summary` is a route on
`APP_URL`. The screenshot stack's env file sets neither variable, so its
listener stays off.

## Still to be written

One half of criterion 11 has no spec in this package yet: the per-association
logo and primary colour regenerating the accent set with its contrast check.
The installing half is `47-installing-from-the-catalog`, and the per-user
light, dark and follow-the-system override is `05-address-book`.

Two more things are worth naming, because in each of them a spec here chooses
a path rather than there being only one:

- **Activation has a screen, and not every spec goes through it.**
  `04-self-signup` opens the link out of the message and fills in the form,
  which is what the person an invitation was written for does.
  `03-invitations` posts the token to the activation endpoint instead, because
  what that spec is about is the invitation rather than the form, and
  `src/provision.ts` does the same when it gives a fixture person an account
  with no browser involved.
- **The register fixture puts people on apartments through sign-up approval.**
  Move-in creates a residency too, and is the path a board actually uses, but
  the fixture predates it and needs no screen to run. `08-move-in-and-move-out`
  drives move-in through the screen rather than reaching for this. The import
  and register specs call the move-in endpoint directly, because a residency is
  what they need in place before they can be about something else.

## Screenshots for a pull request

`CONTRIBUTING.md` requires light and dark screenshots in the pull request
description for UI work. This package produces them, because it already boots
the production stack, signs people in and seeds a register.

```sh
pnpm screenshots
```

It builds the image, brings up a stack of its own from empty volumes, walks
every declared screen and writes two PNGs per screen into `screenshots/` at the
repository root. That directory is git-ignored: the images belong in a pull
request description, not in the history. Drag them out of it and drop them into
the description.

CI walks it as well. A pull request touching `apps/web`, `packages/i18n` or
`e2e/screenshots` runs the walk in a job of its own and attaches the whole of
`screenshots/` to the run, kept for a week; a push to `main` walks whatever it
carries. The walk is the only thing in CI that opens every screen in the client,
so a declared screen that has stopped being reachable is a red check rather than
something the next person to capture by hand discovers - and the images are one
download away from the pull request that changed them.

The stack is a second one, not the suite's: compose project `openbrf-shots`, on
ports 3011, 5443 and 8126, with its image built as `openbrf:shots` rather than
the suite's `openbrf:e2e`, configured by `screenshots.env`. A capture and a
suite run can therefore happen at the same time. More importantly the two
instances hold different data, which the next section is about.

It reads a fixture catalog, as the suite does. The curated catalog lists no
theme yet, so a stack reading it could never show the theme screen's catalog
half, and it lists no plugin the walk may install. Before the screenshot stack
starts, `src/stack.ts` packs the themes in `fixtures/themes` and the plugin in
`fixtures/example-plugin` into a catalog with the script the API's suites
install from (`scripts/build-fixture-catalog.mjs`), in a directory of the
stack's own under the system's temporary directory. `docker-compose.e2e.yml`
mounts it read-only into the application, as it does the suite's, and
`screenshots.env` points `OPENBRF_CATALOG_URL` at it, which takes
`OPENBRF_UNCURATED_PLUGINS_ENABLED` as any index outside the curated one does. The walk lists the themes from it
and installs nothing of them. It installs the plugin, through the same consent
the catalog shows (`{ installPlugin }`), as the last screens in the list:
installing restarts the application, and from then on the plugin's view has an
entry in the navigation of every screen after it. Building the plugin needs its
own dependency install, so the first start also needs the network.

Everybody a walk signs in as has a client address of their own, for the reason
`src/fixtures.ts` gives, and signs in once: the session travels to each browser
they come back in. That is what keeps each of them inside the tight budget on
signing in. The session check every guarded navigation makes has a budget of its
own, sized for a client rather than for a password guess, so a walk that gains
screens takes longer rather than being refused one. The walk watches for a
refusal on any auth endpoint rather than pacing itself to stay clear of one: the
client cannot tell a refusal from having no session, so a walk that met one would
otherwise photograph every screen after it signed out.

### Seeded data has to be safe to publish

**This is a requirement, not a convention.** The images go into pull requests on
a public repository about a statutory personal-data register, so anything a
capture can photograph is published.

The capture builds the demo cooperative - Brf Eksemplet, Storgatan 12 and 14 -
through `src/provision.ts`, which seeds four people with no personal identity
number, no phone number, and email addresses on `.test`, the TLD RFC 2606
reserves so that nothing can resolve. It moves one more person in as a
tenant-owner, so that the two statutory registers have an entry to show, and
she carries neither a number nor a phone number either: everybody the capture
invents is declared in `screenshots/people.ts` under that one rule. It never
runs `db:seed`, whose demo data carries a plausible-looking personal identity
number and Swedish mobile numbers, and which refuses to run without
`--demo-data`, in production, or against a database holding anything but its
own demo rows in any case.

That is checked rather than trusted. Before each image is written, the capture
reads the rendered text, every filled-in field and every embedded frame, and
fails the run on a personal identity number in either form, with or without
its separator, on anything shaped like a Swedish mobile number, or on any email
address outside `.test`. Personal identity numbers are found with the product's own
scanner from `@openbrf/shared`, which checks the date and the check digit. A
Swedish organisation number has the same shape and is not one; the two are told
apart by the date a personal identity number begins with, which an organisation
number is issued unable to carry. A screen that needs new fixture data has to
keep these rules true.

The separate stack is part of the same rule: the suite creates people carrying a
personal identity number and a phone number in order to test masking, and a
capture must never be able to reach them.

### Adding a screen

Append an entry to `screenshots/screens.ts`. It is a list of data, and adding to
it is not writing a test:

```ts
{
  name: "member-register-extract",   // the file stem, so <name>-light.png
  as: "administrator",               // "nobody", "administrator", "resident"
                                     // or "member"
  goto: appPath("/board/registers/members"), // omit to stay where the entry above left off
  prepare: [                         // clicks and fills, when a URL is not enough
    { click: { button: "Skriv ut utdrag" } },
  ],
  waitFor: { heading: "Medlemsförteckning" },
  capture: "page",                   // "viewport" (default), "page", or a target
}
```

The pieces:

- **Order matters, and each entry starts where the one above it stopped.** An
  instance is unclaimed exactly once, so the setup wizard comes first, and its
  seven steps are seven entries on one URL: the wizard keeps its step in React
  state, so `prepare` drives it forward rather than navigating to it. Before
  them, `setup-claim` shows the wizard reached without the setup link, and the
  administrator step opens the link itself: its `goto` is `SETUP_CLAIM_LINK`,
  which the capture replaces with the link the stack's instance printed to its
  log, since the token is minted when the stack starts.
- **`as`** establishes a session. Omit it to carry on in the current one.
  Anything other than `nobody` provisions the cooperative and its register
  first, so an entry never has to arrange that itself.
- **A target** is `{ heading }`, `{ button }`, `{ link }`, `{ combobox }`,
  `{ label }`, `{ text }` or `{ panel }` (a settings card, found by its level-2
  heading). `{ link }` is what proves a navigation panel, the phone bar or its
  sheet has its data, where `{ text }` would also count the hidden
  navigation's copy of the same name.
  There are no test ids in the client on purpose, so these are the names a
  person reads or hears. A string matches exactly, except in `{ label }` and
  `{ combobox }`, where it matches from the beginning: a field's `<label>` wraps
  its hint as well as its word, so `{ label: "Organisationsnummer" }` finds the
  field whose hint follows it, while staying anchored so `{ label: "Namn" }`
  does not also reach "Förnamn". A regular expression always matches as written,
  which is the way out when a name is ambiguous. Matching two things is an
  error, so that an entry which has quietly started finding a second one fails
  instead of photographing whichever came first; add `first: true` where several
  matches are the nature of the screen, as with a control repeated once per
  register row. `within: "Sista dag för motioner"` looks inside the settings card
  of that name rather than at the whole page, which is what a settings section
  needs: it holds several cards, and the cards in one section each offer a
  "Spara" of their own.
- **`waitFor`** proves the right screen rendered and is what the capture waits
  for. It is not optional: it is what stops an image being taken of the screen
  before it.
- **`waitUntilGone`** is optional and makes the capture also wait until nothing
  matches it. The overview sets it to `{ text: "Laddar" }`: its panels each
  read on their own and hold whatever the walk wrote before them, so no single
  row proves the page has finished, but the absence of every panel's loading
  notice does.
- **An action** is `{ click }`, `{ fill, value }`, `{ select, option }`,
  `{ upload, file }`, `{ deliver }`, `{ recordBreach }`,
  `{ requestAuthorization }`, `{ postContactMessages }`, `{ moveIn }`,
  `{ installPlugin }`, `{ scrollTo }`, `{ openLink }`, `{ visit }` or
  `{ see }`. `{ openLink }` goes to the address a field holds, for a link the
  screen composes and shows once, such as the display link that
  `display-page` opens; `{ visit }` goes to an address after the steps before
  it, where `goto` would load the page before an answer a step sets up is in
  place. An uploaded file is written out in the manifest - a name, a media
  type and its text - rather than read from disk, so what a screen is
  photographed reading can be checked against the publishing rules in the diff.
  A delivered letter is written out the same way and put into mailpit, the
  mailbox the board mailbox collects from. `{ recordBreach }` writes up a
  personal data breach over the API and reopens the screen, because no screen
  records one; it is written out in the manifest for the same reason.
  `{ requestAuthorization }` registers a client as the administrator and opens
  its authorization request in the current session, which the instance answers
  with the consent screen and the signed request in its address: no address
  written in the manifest reaches that screen. `{ postContactMessages }` posts
  messages through the public contact form on a page written for the purpose
  and removed again, as a visitor would, and reopens the screen; that is how
  `settings-contact-inbox` shows an inbox with messages in it. `{ moveIn }`
  puts people in the register and moves them into their apartments over the
  API, for a screen about people no other image should show;
  `import-preview-overlapping-residency` uses it for two residents who share a
  name. `{ installPlugin }` installs a plugin from the stack's catalog as the
  board does and waits for the restart that ends the install; the entries that
  need the plugin come last. A screen needing a kind that is not there adds it
  to the `Action` union and to `perform` in `capture.spec.ts`, once, and every
  later screen has it.

Both themes come for free. The client follows the operating system unless
somebody has chosen otherwise, and it subscribes to the media query while it
does, so the capture photographs each screen, flips the emulated preference and
photographs it again without navigating - which is the only way a wizard step,
held in React state, can be shown in both. The viewport, pixel density and
motion setting are fixed in `capture.spec.ts`, and animations are stopped at the
capture, so a rerun differs only where the interface differs. An entry may ask
for a phone's window instead with `viewport: "phone"` (390x844, below the width
where the band gives way to the bottom bar); every entry sets its own, so a
phone entry never leaves its size to the next.

### Screens with no entry yet

Each of these is an entry appended to `screens.ts` by the pull request that next
changes the screen, not later:

- **The result of an import.** The file, the columns and the preview are
  photographed; the walk stops before applying one, because an import writes
  the statutory member register and the walk photographs that register before
  it reaches the import screens.
- **The plugin catalog, the consent screen and a plugin's settings form.** The
  catalog as it lists what can be installed, the permissions and personal-data
  declaration a board consents to, and the form an installed plugin contributes.
- **The theme admin screen's preview and its lint refusal.** Including the
  refusal, which is a screen in its own right: what a board sees when a theme is
  rejected at install time. The fixture catalog already offers the theme that
  is refused, `illegible-theme`. The screen itself is photographed once, as
  `themes-catalog-composed-here`: a theme composed under the id of a catalog
  entry, and the entry saying it will not be installed over it.
- **The association's website with a form on it.** The contact form and the
  issue report form as a visitor meets them, for the same reason: the walk
  photographs the seeded front page, which carries neither.
- **The appearance panel's logo states.** No logo, a logo set, and a logo that
  was refused. `{ panel: "Utseende" }` already photographs that card on its own,
  so these are three entries differing only in what `prepare` sets up.
- **The apartment binder as the board reads it.**
  `board-binders`: the chooser over every apartment, one household's
  binder with the name of whoever filed each entry, the two counts saying how
  many people read it today, and the form that files the board's own alteration
  permission with the day it was decided, on the board's page at
  `/board/binders`. `apartment-binder-member` photographs the household's
  page, which has none of that. The walk
  cannot reach the board's: it is behind `apartmentBinder:manage`, the one
  capability a board seat alone confers and the administrator's grant of every
  capability deliberately withholds (ADR 0017), and this walk elects nobody -
  the feed's entry for the administrator gives that rule, and the register screens it
  photographs are why. An entry needs a seat recorded before it, which is
  either an `Action` kind that asks the instance for something, as the entry
  below needs, or an election driven through the person panel in the
  address book; either way it belongs with the pull request that next changes
  this screen. `specs/44-apartment-binder.spec.ts` covers the board's page,
  including the permission only it can file.
- **A news item with a standing mailing request.** `site-news-mailing-request`:
  the notice a board member reads when a connected app has asked for the item to
  be mailed, and the control that dismisses it. The walk cannot reach the state.
  A request is placed by `POST /api/news/:id/mailing-request`, the board's own
  interface offers no control that places one - deliberately, since the board's
  answer to a request is the publish it already does - and an entry in
  `screens.ts` declares clicks and fills rather than calls. It needs an `Action`
  kind that asks the instance for something before the picture is taken, added
  to the union and to `perform` in `capture.spec.ts` once, as the section above
  describes; the entry itself is then three lines. `36-action-registry.spec.ts`
  covers the state.
