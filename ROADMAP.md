# Roadmap and status

**Can I run this in my housing cooperative today? No.** A first boot now walks
you through creating the housing cooperative, its addresses and its apartments,
and the settings screens are there - but the register itself is not. There is
nowhere to enter a person, nothing to look up, and no way to invite anyone until
the address book lands. The foundations underneath are built and tested. The
project is not ready to hold your housing cooperative's data.

This page exists so anyone who finds the repository can see honestly how far
along it is. It is updated as work lands, in the same pull request that lands
it.

Target dates: pilot in a real housing cooperative **December 2026**, public v1
**Q1 2027**.

## What "usable" will mean

The first milestone worth anyone's attention is a working, deployable address
book. Concretely, all of this has to be true at once:

- `docker compose up` gives a working instance
- a first-boot wizard creates the housing cooperative, its addresses and its
  apartments
- the board can sign in, invite people, and see the register
- the statutory member and apartment registers print correctly and separately
- a resident with protected personal data is masked everywhere
- a real member list imports from CSV or Excel

Until every line above is ticked, self-hosting this is a development exercise
rather than a way to run a housing cooperative.

## Progress

### Foundations

Every checked item below is implemented and covered by tests. None of it is
reachable without an interface, and the one unchecked row says why.

- [x] Core data model: housing cooperative, addresses, apartments, persons,
      residencies, board positions, roles
- [x] Two-tier data model separating the statutory archive from service data
- [x] Statutory registers enforced in the database: the member register and the
      audit log cannot be updated, deleted or truncated, and the apartment
      register's history cannot be deleted
- [x] Field-level encryption at rest with searchable blind indexes for email,
      phone and personal identity number
- [x] Append-only audit log, written in the same transaction as the access it
      records
- [x] Sign-in with password, magic link and TOTP
- [ ] Sign-in with passkeys (WebAuthn): implemented, and a passkey can now be
      enrolled and removed from the security settings. Signing in with one is
      still not covered by tests - driving a WebAuthn authenticator needs the
      end-to-end suite - so this stays unticked until that exists
- [x] Invitation-based account activation
- [x] Board-approved self-signup requests
- [x] Capability-based authorization, protected by default
- [x] Swedish and English throughout the backend, including email
- [x] Transactional email rendered in each recipient's own language
- [x] Background job queue
- [x] Versioned design token contract with WCAG AA contrast enforced in code
- [x] Default theme in light and dark
- [x] Theme engine: the token contract rendered to CSS, Tailwind utilities
      mapped onto it so a theme restyles the whole interface, and light,
      dark and follow-the-system switching
- [x] Self-hosted typefaces, with no font CDN: loading a font from a third
      party would disclose every visitor's IP address to it

### The interface

Under way. This is the gap between the list above and anything usable.
There is now a frame, a way in, and a way to configure the instance; the
screens that do the housing cooperative's work are still ahead.

- [x] Application shell and navigation: the dark band, and a bottom bar on
      narrow screens where a thumb reaches
- [x] Sign-in with a password or an emailed link, with routes closed to
      anyone without a session
- [x] First-boot setup wizard: the first administrator, the housing
      cooperative, any number of street addresses, apartments generated on
      Lantmäteriet numbering and edited before they are saved, SMTP with a test
      send, and the accent colour. Every step after the administrator account
      and the name can be skipped and finished later in settings. The wizard is
      public only while the instance is unclaimed - no account exists and setup
      has never been completed - and admin-only from its second screen onwards,
      because a first-boot wizard that stayed open would be a way to create an
      account on an instance holding a statutory register
- [x] Settings: housing cooperative, addresses and apartments, appearance and
      the accent colour, email, retention, sign-up requests, your own profile,
      and sign-in security. The board can read the instance settings it answers
      for; changing them stays with an admin
- [ ] Uploading the housing cooperative's logo. The accent colour is in place;
      the logo needs an upload path and file serving that do not exist yet
- [x] The address book itself: the board per the design system, with house
      tabs, floor-grouped rows, filter tabs, search, the colour-as-law legend
      and a register stamp; a person and an apartment view; the
      resident-facing variant with no contact column at all; and the audited
      reveal for masked fields

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
- [ ] GDPR engine: data subject access reports, legal hold, consents, masking
      of protected personal data, and configurable retention and purging of
      **service data only**. The statutory registers and the audit log are
      append-only: the law requires the member register to be retained, so no
      retention setting, and no admin, can delete it. That is an exemption
      from purging alone, not from data protection - access control, masking
      of protected personal data, access logging and the data subject access
      report all still cover those records
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
      BRL 9 kap. 14 §, and will never be built.
- [ ] Shared board mailbox
- [ ] Digital home folder for residents
- [ ] Public mini-site generated from the housing cooperative's own data
- [ ] Forms: subletting applications, motions, key orders
- [ ] Simple finances: fee notices, debiting lists, SIE export. Never a
      bookkeeping engine of our own.
- [ ] Reporting to Lantmäteriet's cooperative housing register
      (bostadsrättsregister). Not a single export but a standing duty: an
      initial submission of the existing apartments, then a notification of
      each event the cooperative is responsible for - grant (upplåtelse),
      transfer (övergång) and termination (upphörande) - per Lag (2026:484) om
      bostadsrättsregister, 3 kap. Each has a two-week window, but they do not
      all start from the same moment: for a transfer the clock runs from the
      membership decision rather than the transfer itself, and the statute
      assigns the report to a juridical person in defined cases. Liens
      (pantsättning) are registered by the lienholder, not the cooperative, so
      they are deliberately outside this feature. The exact per-event trigger
      and actor rules belong with the implementation, not this page. A missed notification can affect
      registration and a third party's protection, which makes this a legal
      duty rather than a convenience feature

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
housing cooperative. Nothing here has.

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
