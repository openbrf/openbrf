# Roadmap and status

**Can I run this in my housing cooperative today? No.** A first boot now walks
you through creating the housing cooperative, its addresses and its apartments;
the settings screens are there; and the address book holds people, with a
resident who has protected personal data masked everywhere.

What is missing is most of what a cooperative is obliged to keep. The member
register and the apartment register have no views and no printable extracts.
Moving someone in or out is not built, which is also what writes the statutory
member-register entry. An existing member list cannot be imported. And nobody
can be invited from the interface yet. The project is not ready to hold your
housing cooperative's data.

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
There is now a frame, a way in, a way to configure the instance and a working
register. The statutory register views, the move flows and the import are still
ahead.

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
- [x] Uploading the housing cooperative's logo, in settings and in the wizard's
      appearance step. Two slots, because the band is dark and a mark drawn in
      dark ink disappears on it: a variant for dark surfaces is optional, and
      without one the band puts the mark on a light plate - which the settings
      screen previews rather than leaving a board to discover it
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

### The public website

Decided into v1 on 2026-08-28: the association's own website, replacing the
separate website vendor many cooperatives pay for today. The storage layer
underneath it is built; the site itself is not. The site takes the domain root
and the application moves under `/app`; pages are rendered by the API as plain
HTML through the theme tokens, and the public ones need no JavaScript, set no
cookies and make no third-party requests - which also means no cookie banner.
Search engine optimisation is a non-goal: page titles, and no sitemap or
metadata machinery.

- [x] File uploads and media storage behind one interface, with local-disk
      and S3-compatible drivers both shipped and tested. Files are always
      served through the association's own origin - never a direct link or a
      redirect to the storage endpoint, which would hand every visitor's IP
      to a third party - and the S3 path is tested for exactly that. An
      image upload declares whether it shows identifiable persons, which
      ties it to publication consent. A file is identified from its own
      bytes rather than from the type or the name the request declared, and
      its storage key is generated rather than taken from either. The same
      work unblocks the logo upload above
- [ ] Server-rendered public pages styled by the theme tokens, with the
      application moving under `/app`
- [ ] Page editor: rich text with insertable data blocks - news teasers,
      document list, board roster, association facts, FAQ, and the contact
      and issue report forms. Editing pages, menu and news is a capability
      granted to the board by default and grantable to others; site-wide
      settings stay with an admin
- [ ] Menu editor: top level plus one dropdown level; pages, generated pages
      and external links
- [ ] Public and member-only visibility on pages and news in one site menu,
      gated by sign-in. An anonymous request for a member-only page gets the
      same 404 as for a page that does not exist
- [ ] News on the site, member-only by default, with "email this to the
      members" at publish - a toggle, on by default, sent once through the
      job queue in each recipient's language, and never re-sent on edit
- [ ] Publication guardrails: a person appears on a public page only with a
      recorded publication consent, protected personal data never appears at
      all, a personal identity number scan blocks publishing, minutes default
      to member-only, free-text editors warn against special-category data,
      a fill-in privacy notice page ships footer-linked, and every publish,
      visibility change and consent change lands in the audit log. The
      public rendering path has no route to the statutory registers
- [ ] Broker information page generated from association facts, and the
      public forms - protected by a honeypot and rate limiting, never a
      third-party CAPTCHA: contact to the board (emailed, and stored as a
      submission), issue reports that go straight into the issues module, and an
      apply-for-account page (a setting, on by default)

### Plugins and themes

The plugin system is built: manifest, loader, permissions-scoped SDK, catalog
installation with a consent step, and a command-line tool. See the
architecture decision records in `docs/adr` for the module resolution strategy
it implements, and `docs/plugin-contract.md` for what a plugin author writes
against. It is proven against a catalog and a reference plugin built inside
this repository. What does not exist yet is the ecosystem around it - the
public catalog, the published `@openbrf/plugin-sdk` package and the reference
plugin's own repository - so an instance has nothing to install from until
those are in place. The theme half is not built.

- [x] Plugin manifest, loader and permissions-scoped SDK
- [x] Plugin views loaded at runtime without rebuilding the application
- [x] Curated catalog and installation from the admin interface
- [x] Command-line plugin management
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
- [ ] Public website with a page CMS, replacing the separate website vendor
      many cooperatives pay for today: the association's own site at the domain
      root, public and member-only pages in one editable menu, a broker
      information page generated from association facts, contact and
      issue report forms, and news that can email the members on publish.
      Server-rendered with no JavaScript required, no cookies and no
      third-party requests on public pages - so no cookie banner. Personal
      data reaches a public page only through per-person publication consent,
      and never from the statutory registers
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
- [ ] Digital signage: a display mode for screens in the entrance, stairwell
      and laundry room - news, the event calendar, meeting notices and
      free/busy availability per bookable resource on a rotation. Read-only,
      and carries no personal data: nothing from the registers, and no names,
      apartment numbers or booking history from the bookings either. Paid for
      what surrounds the screen rather than the view itself: Apteo-hosted
      pairing of a screen to a housing cooperative, remote configuration and
      unattended updates of the player
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
