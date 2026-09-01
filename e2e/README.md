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
