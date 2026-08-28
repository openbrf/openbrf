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
  fail; use it with `--grep` on a later spec.
- `OPENBRF_E2E_KEEP_STACK=true` leaves the stack running afterwards, so a
  failing instance can be looked at.

## How it is put together

- `src/stack.ts` owns the compose invocation and reads `stack.env`, so the
  suite and the stack cannot drift apart.
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
