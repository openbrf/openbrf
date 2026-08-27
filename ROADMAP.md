# Roadmap and status

**Can I run this in my association today? No.** There is no user interface yet.
The foundations underneath one are built and tested, but nothing on this page is
usable by a board member or a resident, and the project is not ready to hold
your association's data.

This page exists so anyone who finds the repository can see honestly how far
along it is. It is updated as work lands, in the same pull request that lands
it.

Target dates: pilot in a real association **December 2026**, public v1
**Q1 2027**.

## What "usable" will mean

The first milestone worth anyone's attention is a working, deployable address
book. Concretely, all of this has to be true at once:

- `docker compose up` gives a working instance
- a first-boot wizard creates the association, its addresses and its apartments
- the board can sign in, invite people, and see the register
- the statutory member and apartment registers print correctly and separately
- a resident with protected personal data is masked everywhere
- a real member list imports from CSV or Excel

Until every line above is ticked, self-hosting this is a development exercise
rather than a way to run an association.

## Progress

### Foundations

Everything here is implemented and covered by tests, but none of it is reachable
without an interface.

- [x] Core data model: association, addresses, apartments, persons, residencies,
      board positions, roles
- [x] Two-tier data model separating the statutory archive from service data
- [x] Statutory registers enforced in the database: the member register and the
      audit log cannot be updated, deleted or truncated, and the apartment
      register's history cannot be deleted
- [x] Field-level encryption at rest with searchable blind indexes for email,
      phone and personal identity number
- [x] Append-only audit log, written in the same transaction as the access it
      records
- [x] Sign-in with password, magic link and TOTP
- [ ] Sign-in with passkeys (WebAuthn): implemented, but not yet covered by
      tests. Driving a WebAuthn authenticator needs the end-to-end suite,
      so this stays unticked until that exists
- [x] Invitation-based account activation
- [x] Board-approved self-signup requests
- [x] Capability-based authorization, protected by default
- [x] Swedish and English throughout the backend, including email
- [x] Transactional email rendered in each recipient's own language
- [x] Background job queue
- [x] Versioned design token contract with WCAG AA contrast enforced in code
- [x] Default theme in light and dark

### The interface

Not started. This is the gap between the list above and anything usable.

- [ ] Application shell, navigation and sign-in screens
- [ ] First-boot setup wizard: association, addresses, apartments, SMTP,
      branding
- [ ] Settings, including per-user light and dark mode
- [ ] The address book itself
- [ ] Member register and apartment register views, with printable extracts
- [ ] Move-in and move-out flows
- [ ] Import from CSV and Excel with column mapping
- [ ] Deployable production image and Compose file
- [ ] End-to-end test suite

### Plugins and themes

The riskiest part of the architecture has been prototyped and its findings
written down (see the architecture decision records in `docs/adr`), but the
system itself is not built.

- [ ] Plugin manifest, loader and permissions-scoped SDK
- [ ] Plugin views loaded at runtime without rebuilding the application
- [ ] Curated catalog and installation from the admin interface
- [ ] Command-line plugin management
- [ ] Themes installable as data-only plugins, with inheritance
- [ ] Theme composer in the admin interface

## Core v1

Free, open source, and never moved behind a paywall.

- [ ] Apartment-based address book and member register, with import. Contact
      details and personal identity numbers are encrypted at rest and stay
      searchable through blind indexes; names and postal addresses are held in
      plaintext on purpose, because the statutory register has to be
      searchable and printable. Those are protected by access control,
      masking and the audit log instead
- [ ] The statutory registers under Swedish law: the member register (public on
      request) and the confidential apartment register, kept strictly separate
- [ ] GDPR engine: configurable retention and purging, data subject access
      reports, legal hold, consents, masking of protected personal data
- [ ] News and mailings, by email and through an open SMS adapter
- [ ] Document archive with per-role permissions
- [ ] Issue reporting with photos
- [ ] Roles for board members, residents and external property managers
- [ ] Swedish and English interface
- [ ] Plugin and theme system

Partly built already, as listed under Progress: the address book's data layer,
the registers' storage and guards, authentication, roles, and the theme
foundation.

## After v1

**v1.1**

- [ ] Resource booking: laundry, common rooms, guest apartment, sauna
- [ ] Event calendar with sign-ups

**Later, still free and in the core**

- [ ] General meetings: motions, agenda, voting register, proxies, real-time
      voting. Postal voting is prohibited for a housing cooperative under
      BRL 9 kap. 14 paragraph and will never be built.
- [ ] Shared board mailbox
- [ ] Digital home folder for residents
- [ ] Public mini-site generated from the association's own data
- [ ] Forms: subletting applications, motions, key orders
- [ ] Simple finances: fee notices, debiting lists, SIE export. Never a
      bookkeeping engine of our own.
- [ ] Export to Lantmateriet's cooperative housing register (a legal
      requirement, deadline December 2027)

## Paid modules

Apteo AB maintains Open BRF and funds it by selling hosting and modules. The
boundary is published rather than discovered: paid means it needs Apteo's own
infrastructure, contracts or app store presence. Every module is built against
the same public plugin API that is available to anyone.

- [ ] Mobile app (iOS and Android)
- [ ] BankID and Freja sign-in
- [ ] Document signing
- [ ] AI package: document assistant, issue triage, meeting support
- [ ] Recurring address book import with review
- [ ] Parking space sharing between neighbours
- [ ] Premium themes
- [ ] Advanced booking, advanced finances, maintenance planning, broker and
      property manager packages

## How to read this page

A ticked box means the feature is implemented and covered by tests. It does not
promise the feature is polished, documented, or has ever been used by a real
association. Nothing here has.

Where a whole area is built but not reachable yet, the text says so rather than
letting a row of ticked boxes imply something that is not true.

## Following along

The [architecture decision records](docs/adr) explain why the load-bearing
choices were made, including the ones that turned out to be wrong the first
time. [CONTRIBUTING.md](CONTRIBUTING.md) describes how the project works.

External pull requests are not being accepted yet, and
[CONTRIBUTING.md](CONTRIBUTING.md) explains why. Issues and discussions are very
welcome in the meantime, especially from anyone who sits on a board and knows
what actually matters.
