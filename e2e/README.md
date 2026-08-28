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
  theirs on the run before. The rest re-runs without colliding, because a person
  a spec makes for itself is named for the run that made them
  (`src/identity.ts`).
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
- `src/mailpit.ts` reads the mail the instance really sent. Invitations and
  sign-in links exist only as email, so there is no other way to check them.
- `src/totp.ts` is RFC 6238 in twenty lines, standing in for an authenticator
  app.
- `src/database.ts` reads the audit log directly. It has no read endpoint by
  design - it is evidence, not a feature - and a reveal of protected personal
  data has to reach it.
- `src/fixtures.ts` gives each test its own client address. Better Auth
  rate-limits to twenty requests a minute per client and identifies the client
  by `X-Forwarded-For`; without this the suite would throttle itself.

Specs run serially, in file-name order. `01-first-boot` needs an unclaimed
instance, which an instance is exactly once, and the rest share the instance it
leaves behind rather than each paying for a stack of their own.

## What is covered

Numbered against the phase 1 exit criteria.

| #   | Criterion                                                                                                                                          | Spec                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | First boot serves the wizard; completing it creates the housing cooperative, its addresses, its apartments, the email settings and the first admin | `01-first-boot.spec.ts`                 |
| 2   | Password sign-in, passkey and authenticator app enrolled, sign out, sign in with each                                                              | `02-sign-in-and-second-factors.spec.ts` |
| 3   | A member, a resident on the same apartment and an external board member with no apartment are invited, activate and sign in; sign-in link by email | `03-invitations-and-magic-link.spec.ts` |
| 4   | Self-signup with the toggle on, board approval, activation; the endpoint closed with the toggle off                                                | `04-self-signup.spec.ts`                |
| 5   | The address book: house tabs, floor grouping, filter tabs, signs, legend, register stamp, light and dark and follow-the-system                     | `05-address-book.spec.ts`               |
| 6   | Protected personal data stays masked, reveals are explicit and audited, and a neighbour does not see the person at all                             | `06-protected-personal-data.spec.ts`    |

Two specs are not numbered against a criterion.

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
with the client, query string or no query string.

## Still to be written

Criteria 7 to 11 test features that are not built yet. Each one gets its spec in
this package in the same pull request that builds the feature, not later.

- **7 - Import with column mapping.** A CSV upload, a mapping step, a preview
  showing creates, updates and ambiguous matches, then apply. The xlsx path is
  verified at the integration level rather than here.
- **8 - Move-out and move-in.** Setting a move-out date flips the residency to
  moved out with the dashed sign and the dimmed row, shows the purge date
  computed from the retention policy, records the transfer, and leaves the
  member-register entry immutable. Move-in sends the welcome email in the
  recipient's own language, which this package can already assert through
  mailpit.
- **9 - The statutory registers.** The member register and the apartment
  register as separate views with printable extracts, sharing no screen and no
  endpoint, and the apartment register reaching no one but the board and each
  tenant-owner's own entry.
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

Two smaller gaps are worth naming, because a spec here works around them rather
than pretending they are not there:

- **There is no `/activate` route in the client.** The invitation email points
  at one. The invitation specs take the token from the message and post it to
  the activation endpoint; when the screen exists, they should fill in its form
  instead.
- **A residency is only written by sign-up approval.** No other endpoint creates
  one, so the register fixture goes through that path to put people on
  apartments. Move-in owns this once stage S7 builds it.

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

### Seeded data has to be safe to publish

**This is a requirement, not a convention.** The images go into pull requests on
a public repository about a statutory personal-data register, so anything a
capture can photograph is published.

The capture builds the demo cooperative - Brf Eksemplet, Storgatan 12 and 14 -
through `src/provision.ts`, which seeds four people with no personal identity
number, no phone number, and email addresses on `.test`, the TLD RFC 2606
reserves so that nothing can resolve. It never runs `db:seed`, whose demo data
carries a plausible-looking personal identity number and Swedish mobile numbers,
and which refuses to run against a production image in any case.

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
  as: "administrator",               // "nobody" | "administrator" | "resident"
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
  register row.
- **`waitFor`** proves the right screen rendered and is what the capture waits
  for. It is not optional: it is what stops an image being taken of the screen
  before it.
- **An action** is `{ click }`, `{ fill, value }`, `{ select, option }` or
  `{ see }`. A screen needing a kind that is not there - a file upload, for the
  import steps - adds it to the `Action` union and to `perform` in
  `capture.spec.ts`, once, and every later screen has it.

Both themes come for free. The client follows the operating system unless
somebody has chosen otherwise, and it subscribes to the media query while it
does, so the capture photographs each screen, flips the emulated preference and
photographs it again without navigating - which is the only way a wizard step,
held in React state, can be shown in both. The viewport, pixel density and
motion setting are fixed in `capture.spec.ts`, and animations are stopped at the
capture, so a rerun differs only where the interface differs.

### Screens waiting on other branches

These do not exist yet. Each one is an entry appended to `screens.ts` in the
pull request that builds the screen, not later:

- **The member and apartment register extracts, and the import steps.** The two
  registers as separate printable views, and the upload, column mapping, preview
  and result of an import. The mapping and preview steps are the case that will
  want a file-upload action.
- **The plugin catalog, the consent screen and a plugin's settings form.** The
  catalog as it lists what can be installed, the permissions and personal-data
  declaration a board consents to, and the form an installed plugin contributes.
- **The theme admin screen, its preview and its lint refusal.** Including the
  refusal, which is a screen in its own right: what a board sees when a theme is
  rejected at install time.
- **The appearance panel's logo states.** No logo, a logo set, and a logo that
  was refused. `{ panel: "Utseende" }` already photographs that card on its own,
  so these are three entries differing only in what `prepare` sets up.
