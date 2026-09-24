# End-to-end tests

The suite drives a browser against the production stack: the image built from
this repository's `Dockerfile`, started through `docker-compose.prod.yml` with
the overlay in `docker-compose.e2e.yml`, from empty volumes.

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

While writing a spec:

- `OPENBRF_E2E_REUSE_STACK=true` runs against a stack that is already up and
  skips the rebuild. It also skips the fresh volumes, so `01-first-boot` will
  fail; use it with `--grep` on a later spec. The first test in
  `03-invitations` fails on a reused instance too, and has to: an invitation
  activates an account for a person who has none, and the two it invites got
  theirs on the run before. The rest re-runs without colliding, because a
  person a spec makes for itself is named for the run that made them
  (`src/identity.ts`), and an apartment a spec moves somebody into is claimed
  for the run that claimed it (`src/apartments.ts`).
- `OPENBRF_E2E_KEEP_STACK=true` leaves the stack running afterwards, so a
  failing instance can be looked at.

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
  screenshot task's, selected with `OPENBRF_E2E_PROFILE=screenshots`.
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
leaves behind rather than each paying for a stack of their own.

## What is covered

Numbered against the phase 1 exit criteria.

| #   | Criterion                                                                                                                                           | Spec                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | First boot serves the wizard; completing it creates the housing cooperative, its addresses, its apartments, the email settings and the first admin  | `01-first-boot.spec.ts`                 |
| 2   | Password sign-in, passkey and authenticator app enrolled, sign out, sign in with each                                                               | `02-sign-in-and-second-factors.spec.ts` |
| 3   | A member, a resident on the same apartment and an external board member with no apartment are invited, activate and sign in; sign-in link by email  | `03-invitations-and-magic-link.spec.ts` |
| 4   | Self-signup with the toggle on, board approval, activation; the endpoint closed with the toggle off                                                 | `04-self-signup.spec.ts`                |
| 5   | The address book: house tabs, floor grouping, filter tabs, signs, legend, register stamp, light and dark and follow-the-system                      | `05-address-book.spec.ts`               |
| 6   | Protected personal data stays masked, reveals are explicit and audited, and a neighbour does not see the person at all                              | `06-protected-personal-data.spec.ts`    |
| 7   | A member list imported: the columns mapped, every outcome previewed, the member register written, and the run found again after a reload            | `07-import-with-column-mapping.spec.ts` |
| 8   | Move-in writes the member register and welcomes the person in their own language; move-out states the purge date and keeps the entry                | `08-move-in-and-move-out.spec.ts`       |
| 9   | The two statutory registers as separate documents, the printed extract, the audited full apartment register extract, and a tenant-owner's own entry | `09-statutory-registers.spec.ts`        |

Some specs are not numbered against a criterion.

`90-runtime-role-privileges.spec.ts` connects as `openbrf_app` - the role the
entrypoint created and constrained with `prisma/sql/harden-runtime-role.sql` -
and checks both halves of that hardening: the queue works (a queue is created, a
job is sent and a worker receives it) and the statutory archive still refuses an
`UPDATE`. It also exercises the `CREATE` on the `pgboss` schema directly, so the
grant fails loudly if it is ever dropped rather than only when a background job
does. It reads the database on the port `docker-compose.e2e.yml` publishes, so
it needs no browser.

Its last test reads the server process's own environment from inside the
container, finds the process by its arguments rather than trusting a pid, and
puts every connection URL it holds against the member register. Two roles are
only a boundary while the owner's credentials are out of the application's
reach, so the test fails if `DATABASE_URL` or either password survives into the
process the entrypoint starts.

`91-startup-and-connection-urls.spec.ts` covers what the image does with the
database password and with a request that belongs to nobody: the first-boot
check reports an unreachable database without writing the connection URL into
the startup log, a password carrying `:`, `/` and `@` survives the URLs the
entrypoint builds from it - which is why `stack.env` gives both roles one - and
an unknown `/api` path answers the API's JSON 404 while a client route answers
with the client, query string or no query string. Since the client moved under
`/app`, it also holds the other half of that split: a traversal shape aimed at
the root meets the association's website and gets its not-found page rather than
the client's index.

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
every page. It is the third spec allowed to navigate the instance root, because
reading the published page on the website is the assertion.

`26-site-menu.spec.ts` drives the menu. The board builds a top level and one
level under it, moves an entry to the front and watches the website's front page
follow it, and the same website is then read twice: by a visitor with no
account, who is not told the members-only page exists, and by the board member's
own session, who is. The dropdown is opened with the keyboard rather than with a
pointer, because the site runs no script and focus is the only thing that opens
it. It is the fourth spec allowed to navigate the instance root, for the same
reason as the one above: the menu is chrome on the website itself.

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
under art. 20, in a file that carries what she gave the association and not the
statutory registers, the audit trail or her personal identity number.

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
there - is not in this package and cannot be. The resource is a connector
plugin's own route; this stack installs no plugin, so nothing declares one, and
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

`40-board-chat.spec.ts` drives the board's own chat, and its subject is delivery.
A message written in one browser reaches a second browser that was never
reloaded and never navigated, which is the whole claim a poll makes and the one
thing neither the unit tests nor the integration suite can show: they hold the
poll's mechanics and what the endpoints answer, and neither of them has a second
screen open. It is asserted by waiting for the text, so it passes as soon as the
first poll after the write lands; waiting out the four-second interval instead
would be asserting the clock and would flake the day the machine was busy. The
spec also covers the half of the feature that is a refusal - somebody who lives
here is offered no link to the room and is told in plain Swedish that it is the
board's, and the endpoint refuses them by name - the personal identity number
guardrail with the response read as well as the screen, and a room longer than
one page, where the messages before the newest fifty are one press away rather
than quietly missing. The seats it needs are granted with `grantBoardSeat`,
because the shared fixture provisions people through the sign-up approval path
and that writes residencies and nothing else. The second board member the
two-browser test needs is created by the spec rather than borrowed: the fixture
holds four people and the seeded administrator is not among them, and a person
needs no apartment, no residency and no membership to hold a seat.

`43-chat-groups.spec.ts` drives the other kind of room, and its subject is who
may reach one. A resident makes a group from the screen with nobody appointing
it, picks a neighbour out of the people who live here and puts them in, and the
neighbour finds the room on their own screen. Somebody who is in neither is
answered for that room exactly as for a room that does not exist - the same
status and the same body, asserted as an equality, because anything that told
them apart would let the identifier space be walked to learn what rooms the house
has made. And the board's one way in: a member of the room reports a message, the
board reads that message in its queue with the room named beside it and nothing
else of the room, strikes it through, and the room loses the text while its
author keeps it. That path crosses three sessions and two capabilities, which is
what makes it a test only a served instance can carry. Every person in it is
created by the spec, moved in through the ordinary move-in path so that the
residency a place in a group rests on is a real one.

Deliberately not here: an account that holds `chat:participate` and no board
seat, which is the instance's own administrator and is answered with no room at
all. Three earlier specs put the shared administrator on the board and the grant
is idempotent, so on this instance they have a seat.
`apps/api/src/chat/chat.int-spec.ts` covers that case against people it builds
itself, along with there being exactly one board chat however many readers
arrive at once, the refusal for an unknown room being the same refusal as for a
room somebody is not in, the access report section, and the nightly purge with
its legal hold. `apps/api/src/chat/chat-group.int-spec.ts` is the same for a
group: a place in one ending the day the residency does, the audit entries the
three acts write, what the access report says about a room and about what
somebody reported, and the purge erasing a group that has held nothing for a
year along with the list of who was in it.

## Still to be written

Criteria 10 and 11 have no spec in this package yet, and neither is waiting on
the feature. Installing a plugin and installing a theme are both built and both
carry their own tests against fixtures built in this repository. What is missing
is on two sides: a browser driving either against the production image, which is
the only place the entrypoint, the constrained database role and the built
client are the ones a housing cooperative installs; and something real to
install, since the reference plugin and the example theme belong to repositories
that do not exist yet.

- **10 - Installing a plugin.** From the admin screen: permissions and the
  personal-data declaration shown and consented to, the sha512 verified, a
  graceful restart, then the plugin's API route, its federated view, its merged
  translations and its settings form. Then the same install and removal from the
  command line. Stage S8 builds a local fixture catalog whose tarballs are baked
  into the test image, so the install path is exercised with the real verify
  code and no network; point `OPENBRF_CATALOG_URL` at it in
  `docker-compose.e2e.yml` and add the tarballs to the image, and this package
  needs nothing else.
- **11 - Installing a theme.** From the admin theme screen, without a restart:
  the install-time lint, the live preview, activation, the per-cooperative logo
  and primary colour regenerating the accent set with its contrast check, and
  the per-user light/dark/system override.

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
ports 3011, 5443 and 8126, configured by `screenshots.env`. A capture and a
suite run can therefore happen at the same time. More importantly the two
instances hold different data, which the next section is about.

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
number and Swedish mobile numbers, and which refuses to run against a
production image in any case.

That is checked rather than trusted. Before each image is written, the capture
reads the rendered text and every filled-in field, and fails the run on anything
shaped like a personal identity number, or on any email address outside `.test`.
A Swedish organisation number has the same shape and is not one; the two are
told apart by the date a personal identity number begins with, which an
organisation number is issued unable to carry. A screen that needs new fixture
data has to keep both rules true.

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
  goto: "/register/members",         // omit to stay where the entry above left off
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
  state, so `prepare` drives it forward rather than navigating to it.
- **`as`** establishes a session. Omit it to carry on in the current one.
  Anything other than `nobody` provisions the cooperative and its register
  first, so an entry never has to arrange that itself.
- **A target** is `{ heading }`, `{ button }`, `{ combobox }`, `{ label }`,
  `{ text }` or `{ panel }` (a settings card, found by its level-2 heading).
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
  of that name rather than at the whole page, which is what the settings route
  needs: every card is on it, seven of them offer a "Spara" and two hold a field
  whose label begins "Dag".
- **`waitFor`** proves the right screen rendered and is what the capture waits
  for. It is not optional: it is what stops an image being taken of the screen
  before it.
- **An action** is `{ click }`, `{ fill, value }`, `{ select, option }`,
  `{ upload, file }` or `{ see }`. An uploaded file is written out in the
  manifest - a name, a media type and its text - rather than read from disk, so
  what a screen is photographed reading can be checked against the publishing
  rules in the diff. A screen needing a kind that is not there adds it to the
  `Action` union and to `perform` in `capture.spec.ts`, once, and every later
  screen has it.

Both themes come for free. The client follows the operating system unless
somebody has chosen otherwise, and it subscribes to the media query while it
does, so the capture photographs each screen, flips the emulated preference and
photographs it again without navigating - which is the only way a wizard step,
held in React state, can be shown in both. The viewport, pixel density and
motion setting are fixed in `capture.spec.ts`, and animations are stopped at the
capture, so a rerun differs only where the interface differs.

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
- **The theme admin screen, its preview and its lint refusal.** Including the
  refusal, which is a screen in its own right: what a board sees when a theme is
  rejected at install time.
- **The contact inbox with a message in it.** `settings-contact-inbox`
  photographs the card empty, which is what a board sees before anybody has
  written to them. A populated one needs a published page carrying the contact
  block, and the walk has no way to place one until the page editor offers the
  form blocks.
- **The association's website with a form on it.** The contact form and the
  issue report form as a visitor meets them, for the same reason: the walk
  photographs the seeded front page, which carries neither.
- **The appearance panel's logo states.** No logo, a logo set, and a logo that
  was refused. `{ panel: "Utseende" }` already photographs that card on its own,
  so these are three entries differing only in what `prepare` sets up.
- **The apartment binder as the board reads it.**
  `apartment-binder-board`: the chooser over every apartment, one household's
  binder with the name of whoever filed each entry, the two counts saying how
  many people read it today, and the form that files the board's own alteration
  permission with the day it was decided. `apartment-binder-member` photographs
  the household's half, which is the same route without any of that. The walk
  cannot reach the board's: it is behind `apartmentBinder:manage`, the one
  capability a board seat alone confers and the administrator's grant of every
  capability deliberately withholds (ADR 0017), and this walk elects nobody -
  the board chat entry gives that rule, and the register screens it
  photographs are why. An entry needs a seat recorded before it, which is
  either an `Action` kind that asks the instance for something, as the two
  entries below need, or an election driven through the person panel in the
  address book; either way it belongs with the pull request that next changes
  this screen. `specs/44-apartment-binder.spec.ts` covers the board's half,
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
- **The consent screen a member answers for a connected app.**
  `connected-app-consent`: which app is asking, where its answer goes, what it
  could do with this person's own standing, and the acknowledgement and button
  that grant it. The walk cannot reach the address. The screen renders from a
  signed authorization request in its query string, which takes a registered
  client - `POST /api/oauth-clients`, or a metadata document the instance
  fetches - and a call to the authorize endpoint with a code challenge, which
  answers with the address the request is carried on. An entry in `screens.ts`
  declares clicks and fills rather than calls, so it needs the same `Action`
  kind the mailing request above needs, and one thing beyond it: the address to
  navigate to is composed by that call, while `goto` is a string written in the
  manifest - so the kind has to be able to hand its answer to the navigation.
  `apps/web/src/connected-apps/OAuthConsentScreen.test.tsx` covers the screen,
  and `37-mcp-sign-in.spec.ts` covers the route sending somebody with no session
  to sign in first.
