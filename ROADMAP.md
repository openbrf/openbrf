# Roadmap and status

**Can I run this in my housing cooperative today? No.** A first boot now walks
you through creating the housing cooperative, its addresses and its apartments;
the settings screens are there; the address book holds people, with a resident
who has protected personal data masked everywhere; the member register and the
apartment register have their own views and print correctly; someone can be
moved in and out; and an existing member list imports from CSV or Excel. All of
it runs from one Compose command against a production image, with an end-to-end
suite driving a browser against that image.

The way in is there now: a board member invites a person from the register, the
invitation arrives as an email, and the link in it opens a screen where the
recipient chooses a password and is signed in as soon as it is set. Who that
person then is on the instance is settled from the application as well: the
board records an election to a position of trust with the date the meeting was
held, an administrator grants a second administrator or an external property
manager their access, and the instance refuses to let go of its last
administrator. Nothing about a role is entered by hand in the database any
more. The association's own website is there as well - the site answers at the
domain root, the application is served under `/app`, and a page is rendered as
plain HTML with no JavaScript, no third-party requests and no cookie of its
own. The board writes those pages from the application now, with the
publication guardrails inside the write path, arranges the menu a visitor finds
them through, and answers a broker from the facts it has recorded. A page can
also carry the blocks that draw on the instance's own data: the document list,
the board roster, the association facts, a FAQ and the association's calendar.
The project is not ready to hold your housing cooperative's data.

This page exists so anyone who finds the repository can see honestly how far
along it is. It is updated as work lands, in the same pull request that lands
it.

Target dates: pilot in a real housing cooperative **December 2026**, public v1
**Q1 2027**.

## What "usable" will mean

The first milestone worth anyone's attention is a working, deployable address
book. Concretely, all of this has to be true at once:

- one `docker compose` command gives a working instance
- a first-boot wizard creates the housing cooperative, its addresses and its
  apartments
- the board can sign in, invite people, and see the register
- a board seat, a second administrator and an external property manager's
  access are conferred from the application rather than written into the
  database by hand
- the statutory member and apartment registers print correctly and separately
- a resident with protected personal data is masked everywhere
- a real member list imports from CSV or Excel

Until every line above is ticked, self-hosting this is a development exercise
rather than a way to run a housing cooperative.

## Progress

### Foundations

Every checked item below is implemented and covered by tests.

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
- [x] Sign-in with passkeys (WebAuthn): a passkey is enrolled and removed from
      the security settings, and signing in with one is now covered end to end
      against a virtual authenticator. No email address is typed and no
      one-time code is asked for: a passkey is phishing-resistant, so it is not
      gated behind the authenticator app
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
There is now a frame, a way in, a way to configure the instance, the address
book, the two statutory registers with their printable extracts, the move flows
and the import. A housing cooperative runs all of it with
`docker compose -f docker-compose.prod.yml --env-file .env.production up -d`;
locally the application runs from source beside the PostgreSQL that
`docker compose up` starts.

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
      the accent colour, email, retention, sign-up requests with the board's
      queue for deciding them, your own profile, and sign-in security. The board
      can read the instance settings it answers for; changing them stays with an
      admin. A waiting request shows the address and apartment the applicant
      typed, exactly as they typed it, beside the register's own addresses: the
      board matches the claim to a real apartment and approves it, or turns it
      away with a reason. Approving creates the person, the residency and the
      invitation; the public form that feeds the queue is at /request-account
      and says plainly that nothing is created until somebody approves it
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
- [x] Invitations from the interface: the board sends one from the person view
      and sends it again when an email goes missing, with the date the link
      stops working shown beside it. The emailed link opens a screen where the
      recipient chooses a password, and a successful activation leaves them
      signed in rather than at a sign-in form. A link that was already used, one
      that has run out and an account that already exists are three different
      sentences, each in the recipient's own language

- [x] Member register and apartment register views, with printable extracts:
      two separate screens on two separate endpoints, because the member
      register is public on request and the apartment register is confidential.
      The member register extract carries names, postal addresses, apartments
      and the membership dates and never a personal identity number; the
      apartment register carries the holders, the initial share capital, the
      participation share, the lien notes and the transfers, and is open to the
      board and to each tenant-owner for their own entry. Identity numbers are
      masked until the full statutory copy is asked for, and the audit log
      records who took it and whose numbers it held. Both print through a print
      stylesheet, so a browser's own "save as PDF" produces the document
- [x] Move-in and move-out flows: moving in creates the residency, writes the
      statutory member register entry when the person takes over a
      tenant-ownership, records the transfer, and emails the welcome in the
      recipient's own language. Moving out sets the date, shows the purge date
      computed from the retention policy, records the transfer, closes the
      membership in the register when the person's last tenant-ownership ends,
      and has the board reminded on the day
- [x] Import from CSV and Excel with column mapping: the columns are guessed
      from their titles in either language and confirmed by hand, and a preview
      shows every row that would be created, every person that would be matched
      and every row with a problem before anything is written. A row matching
      more than one person waits for a decision rather than picking one. An
      update fills in what the register does not have and never overwrites what
      it does. The register write itself runs in the background, in chunks, with
      the rows it has done shown as it goes: a whole cooperative's list goes in
      at once, the page can be closed while it runs, and an import interrupted by
      a restart carries on from where it stopped rather than writing anything a
      second time
- [x] Document archive: the association's own documents - bylaws, minutes,
      house rules, the annual report - each filed in a binder the board names
      itself and each carrying the audience it is for. The board sees all three
      shelves, a member sees theirs and the published one, a resident who is
      not a member sees what is published, and a visitor with no account can
      fetch a published document at its own address. The audience is written
      onto the stored file in the same transaction, so taking a document off
      the public shelf takes the file off the street with it, and every time a
      board document is opened that lands in the audit log. Minutes go to the
      members unless the board publishes a particular set deliberately
- [x] Deployable production image and Compose file: one container serving the
      API and the built client, one PostgreSQL beside it, named volumes and
      health checks on both. The entrypoint provisions the field encryption key
      on a genuine first boot and refuses to invent one on any later boot,
      applies migrations, installs the job queue schema, and creates the
      constrained database role the application connects as - so the
      application never owns the tables whose triggers keep the statutory
      registers append-only. Backing up is
      [documented](docs/backup-and-restore.md) as one job covering the database
      and the encryption key together, because either without the other is not
      a backup
- [x] End-to-end test suite, driving a browser against that production image
      rather than a development server. It covers the first nine of the thirteen
      phase 1 exit criteria: first boot through the wizard; password sign-in,
      passkey and authenticator app enrolment and signing in with each;
      invitations sent from the person view for a member, a resident and an
      external board member with no apartment, each activating from the link in
      their email and landing signed in, plus a sign-in link by email;
      self-signup through the public form, approved from the board's queue
      against a real apartment and turned away with a reason, and closed in
      both the screen and the endpoint with the toggle off; the address book
      with its house tabs,
      floor grouping, filter tabs, signs, legend and register stamp in light,
      dark and follow-the-system; protected personal data staying masked with
      every reveal landing in the audit log; an import mapped column by column,
      previewed row by row - creates, updates, a row matching two people and a
      row that cannot be read - and then written to the member register; a move-in
      that writes the member register and welcomes the person in their own
      language, and a move-out that states the purge date the retention policy
      derives while the register entry stands; and the member register and the
      apartment register as two documents on two screens, printed as documents,
      with the full apartment register extract recorded in the audit log. The four
      that remain are not driven from here: installing a plugin and installing
      a theme are both built and tested against fixtures built in this
      repository, but the reference plugin and the example theme a browser
      would install belong to repositories that do not exist yet, and the last
      two are about continuous integration and those same repositories rather
      than about a screen. Beside the numbered criteria, one spec holds the
      public website to what it promises its readers: no script runs, no cookie
      is set, every request the page makes goes to the housing cooperative's
      own instance, and a member-only page is indistinguishable from one that
      does not exist
- [x] Conferring a role, from the person view in the register. The board
      records an election to a position of trust - the position and the date
      the general meeting was held - and says when a term ends by writing the
      date, which leaves the row and the period it covered on file. That date
      may be ahead of today, so a board can minute in April that a term runs to
      the annual meeting; it is bounded to a plausible horizon, because a seat
      goes on conferring what a seat confers until the date arrives, and it
      stays correctable from the same screen until it passes. An administrator
      grants and revokes the administrator role and the external property
      manager's access on the same panel, and nobody else is offered those
      controls because nobody else holds the capability behind them. A grant
      takes effect on the next request without an account being touched,
      because roles are derived from the register rather than stored on the
      account. The one refusal that cannot be retried says so: the last
      administrator cannot be revoked, and the screen says to grant the role to
      somebody else first
- [x] Issue reporting: a resident reports a problem with the building from the
      application, with photographs, and follows what happens to it. The
      issue types are the board's own - each one set to non-member, member or
      board - and which of them a person is offered is decided on the server:
      a resident picks from the member types, a visitor with no account from the
      non-member ones, and the board's internal categories are shown to nobody
      who does not handle issues. Whoever does works one queue, and moves a
      report between new, in progress and done. The form warns that health
      details and anything about a neighbour are read by everyone who handles
      issues, and refuses nothing: an issue report is where such detail
      legitimately arrives. A reporter with protected personal data is named to
      nobody in the queue. Whether the association's website takes reports from
      anyone is a setting, on by default, and the server already answers a
      caller with no session with the non-member types alone; the form itself
      is part of the public forms below

### The public website

Decided into v1 on 2026-08-28: the association's own website, replacing the
separate website vendor many cooperatives pay for today. The site takes the
domain root, the application is served under `/app`, and a page is rendered by
the API as plain HTML through the theme tokens. A public page needs no
JavaScript, sets no cookies and makes no third-party requests - which also means
no cookie banner. The board writes those pages now: text with emphasis and
links, headings and pictures, each page published or not and public or for the
members, with the publication guardrails inside the write path rather than
beside it, arranges the menu a visitor finds those pages through, and answers a
broker from the facts it records itself. A page can also carry the blocks that
draw on what the instance already knows. Search engine optimisation is a
non-goal: page titles, and no sitemap or metadata machinery.

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
- [x] Server-rendered public pages styled by the theme tokens, with the
      application moved under `/app`. A page is stored as a versioned block
      list rather than as markup, so the renderer decides what a block becomes
      and no stored page can carry a script, or make the reader's browser fetch
      anything from a third party, into a later renderer - a picture names a
      stored file by its id and never a URL, and a link the board writes is a
      navigation the visitor chooses rather than something fetched while the
      page is read. The stylesheet is assembled from the active theme on the
      server and inlined, the typefaces are served from the association's own
      origin, and the content security policy names no script source at all.
      Member-only pages are readable by anyone signed in and answered to
      everyone else with the same not-found document, byte for byte, that an
      address with no page behind it gets
- [x] Page editor: the board writes the association's pages from the
      application - paragraphs with emphasis and links, headings, and pictures
      served from the instance's own origin - and each page is a draft until it
      is published. What is stored is a block list rather than markup, so the
      editor is a mapping onto the website's own format and never a second
      format of its own; a preview is rendered by the website itself, so what
      the board approves is what a visitor is served. Writing the website is a
      capability granted to the board by default and grantable to others, and
      it opens page editing today; the menu and news editors below are the
      later work it will also cover. Site-wide settings stay with an admin
- [x] The remaining insertable data blocks: document list, board roster,
      association facts and FAQ. These four are the ones that need no feature
      of their own, only the block and its rendering. The news teaser and the
      two form blocks render and are validated but no screen offers them yet:
      placing one belongs to the screen that owns the feature rather than to
      the page editor, and that half has not been built, so today only a direct
      call to the API can put one on a page. A document list follows the
      archive's own audience for whoever is reading, per document and per
      reader: a visitor with no account is shown the public shelf, somebody
      signed in is shown what their own account may open as well, and the
      board's shelf is on no page at all. A board roster names the people who
      have given a publication consent for exactly that, and never anybody
      carrying protected personal data. The facts are the ones the broker
      information page is generated from, rendered by the same code, and the
      FAQ is the board's own writing carried in the block itself
- [x] Menu editor: top level plus one dropdown level; pages, generated pages
      and external links. The menu is also the ordering of the site - its
      first page entry is the front page, so there is no separate home-page
      setting to disagree with it - and the dropdown is opened by the
      stylesheet rather than by a script, so it answers a keyboard on a page
      that runs none. An entry for a generated page is left out of the menu
      while that page does not exist, and one for an address elsewhere is a
      link and never a request: a menu survives a feature being switched off,
      and reading a page still tells no other host that anybody was here
- [x] Public and member-only visibility in one site menu, gated by sign-in.
      A page kept for the members is readable by anyone signed in and answered
      to everyone else with the same not-found document, byte for byte, that an
      address with no page behind it gets - and the menu follows the same rule,
      so the entry for such a page is absent from the menu a visitor with no
      account is served rather than shown and refused. The navigation therefore
      cannot become the thing that tells them the page is there. News carries a
      visibility of its own and arrives with the news module below
- [x] News on the site, member-only by default, with a news mailing at
      publish - a toggle, on by default, sent at most once through the job
      queue in each recipient's language, and never re-sent on edit
- [x] Publication guardrails, inside the write path rather than beside it: a
      picture reaches a published page only once the board has confirmed the
      recorded publication consents of everyone who can be recognised in it, a
      personal identity number anywhere on a page refuses the publication and
      says which block it is in without repeating the number, minutes default
      to member-only, the editor warns against writing special-category data
      about a named person, a fill-in privacy notice ships footer-linked on
      every page, and every publish, visibility change and consent change is
      written to the audit log in the transaction that made it. Protected
      personal data never appears at all, because the public rendering path
      imports neither the registers, the address book nor the encryption layer - which a test asserts on the source rather than on a rendered page
- [x] Broker information page generated from association facts: the property
      designation and build year, whether the association owns its land, how
      the fee is set and what it covers, the transfer and pledge fees, whether
      a legal person may be a member, parking, storage and renovations. The
      board records them, and the page omits every question it has not
      answered rather than printing an empty one. Nothing personal and
      nothing per-apartment reaches it - the only value no board member typed
      is how many apartments the association has, an aggregate over the
      apartment register
- [x] The public forms - protected by a honeypot and rate limiting, never a
      third-party CAPTCHA: contact to the board (emailed, and stored as a
      submission), issue reports that go straight into the issues module, and an
      apply-for-account page (a setting, off by default: an instance holding a
      statutory register does not accept open registration until its board says
      so)

### Plugins and themes

Both halves are built. The plugin system carries the manifest, the loader, the
permissions-scoped SDK, catalog installation with a consent step, and a
command-line tool; see the architecture decision records in `docs/adr` for the
module resolution strategy it implements, and `docs/plugin-contract.md` for what
a plugin author writes against. Themes are the easier half by design: a theme
carries no code at all, so installing one needs no restart and puts nothing into
the running process.

What neither has yet is the ecosystem around it. The public catalog, the
published `@openbrf/plugin-sdk` package, the reference plugin and the example
theme belong in repositories that do not exist, so an instance has nothing to
install from until they do. Both install paths are so far proven against a
catalog and packages built inside this repository. Composing a theme needs no
catalog at all: the manifest is written on the instance and admitted through the
same lint gate a downloaded package passes.

- [x] Plugin manifest, loader and permissions-scoped SDK
- [x] Plugin views loaded at runtime without rebuilding the application
- [x] Curated plugin catalog and installation from the admin interface
- [x] Command-line plugin management
- [x] Themes installable as data-only plugins, with inheritance. A theme is a
      manifest, token values and bundled font files. It installs from a
      catalog: the package is verified against the checksum the catalog states,
      then linted, and only then written to disk. The lint is a gate rather
      than advice - it refuses a theme that renders the statutory register
      below WCAG AA, one that carries anything executable, and one that fetches
      a font from a third party. A theme states only what it changes and
      inherits the rest; the default theme is built in, always inheritable and
      cannot be removed. A board member previews a theme in their own browser
      before activating it, and activating one restarts nothing
- [x] Theme composer in the admin interface. An administrator names a theme,
      chooses the theme it inherits from and changes the colours they want
      changed. The draft is previewed in their own browser and nowhere else,
      and saving it runs the same lint a catalog install runs, so it lands as
      an ordinary installed theme that can be previewed, activated, edited
      again and removed

## Core v1

Free, open source, and never moved behind a paywall.

- [x] Apartment-based address book and member register, with import. Contact
      details and personal identity numbers are encrypted at rest and stay
      searchable through blind indexes; names and postal addresses are held in
      plaintext on purpose, because the statutory register has to be
      searchable and printable. Those are protected by access control,
      masking and the audit log instead
- [x] The statutory registers under Swedish law: the member register (public on
      request) and the confidential apartment register, kept strictly separate
- [x] GDPR engine: data subject access reports, legal hold, consents, masking
      of protected personal data, and configurable retention and purging of
      **service data only**. The statutory registers and the audit log are
      append-only: the law requires the member register to be retained, so no
      retention setting, and no admin, can delete it. That is an exemption
      from purging alone, not from data protection - access control, masking
      of protected personal data, access logging and the data subject access
      report all still cover those records. Publication consent is recorded
      already: the board notes, per person and per scope, what the person
      agreed may appear on a published page, and a withdrawal keeps the dates
      the consent applied between rather than erasing them. The purge runs
      nightly and erases contact details, the account and unaccepted
      invitations once the retention window on somebody's last residency has
      run out; a legal hold, entered against one person with a reason,
      suspends it until the board releases it. Issues and archived documents
      are listed in the data subject access report but not yet purged
- [x] News on the association's website and by email: an item is for the
      members unless the board publishes it to the street, and publishing mails
      every member once - a toggle, on by default - through the job queue and
      in each recipient's own language, never again on an edit
- [x] An open SMS adapter, so the same notice can also reach a member as a text
      message. Each channel is claimed once - one ledger row per recipient per
      channel, claimed before anything is handed to a mail server or a provider - so a correction and a retry reach nobody twice. It is an adapter rather
      than a vendor integration: no provider's package is a dependency, the
      board configures the one it pays for in settings, and an instance with
      none configured publishes the item all the same and says on the screen
      that the SMS mailing was what did not go out
- [x] Public website with a page CMS, replacing the separate website vendor
      many cooperatives pay for today: the association's own site at the domain
      root, public and member-only pages in one editable menu, a broker
      information page generated from association facts, contact and
      issue report forms, and news that can email the members on publish.
      Server-rendered with no JavaScript required, no cookies and no
      third-party requests on public pages - so no cookie banner. Personal
      data reaches a public page only through per-person publication consent,
      and never from the statutory registers
- [x] Document archive with per-audience access: every document is for the
      board, for the members or for anyone, and the file behind it is served
      under the same decision
- [x] Issue reporting with photos
- [x] Roles for board members, residents and external property managers, and
      conferring them from the application. The model is enforced as before:
      the code asks what a principal may do rather than which role they hold,
      a board seat does not carry an administrator's rights, and an external
      property manager reaches the issue queue and never the address book -
      which the end-to-end suite checks. Every role now has a write path. A
      residency and its member or resident role are written by the move-in, by
      the import and by an approved sign-up request; a board seat, the
      administrator grant and the property manager grant are written from the
      person view in the register. Who may confer what is itself a capability
      rather than a role check: the board records its own election, because a
      board is elected by the general meeting and the application holds the
      minute of it, and the seat it confers carries nothing its writer does
      not already hold. Granting a system role is an administrator's, and the
      board holds no capability that reaches that table at all - so a board
      seat cannot become a way to grant oneself administrator rights, because
      no route exists on which a board member writes the grant rather than
      because a check inside one refuses it. The external property manager
      grant sits on that side with the administrator grant although what it
      carries is a subset of the board's own, because it is a standing grant
      to somebody who neither lives in the building nor was elected to
      anything, which is the same kind of decision as installing a plugin. A
      board seat is a dated period and the row keeps it: ending a term writes
      the date it ended and leaves the row where it was, an end date in the
      future is an ordinary date so a board can minute in April that a term
      runs to the annual meeting, and a re-election is two acts rather than an
      edit so both periods stand with their own dates. A future end date is
      bounded and correctable, because the seat confers what it confers until
      the date arrives: a term cannot be recorded as running for a century, and
      one recorded for the wrong year is corrected from the screen for as long
      as the date is still ahead. Every election, end of term, grant and revoke
      is written to the append-only audit log in the same transaction as the
      change. And the instance cannot be shut from the inside: the last
      administrator cannot be revoked, including by that administrator revoking
      their own grant, and the refusal says to grant the role to somebody else
      first rather than to try again
- [x] Swedish and English interface: both languages are complete and carry the
      same keys, each person chooses theirs in their own profile, and the
      public website answers a visitor with no account from the language their
      browser asks for
- [x] Plugin and theme system. There is nothing to install from yet: the
      public catalog, the published SDK package, the reference plugin and the
      example theme belong in repositories that do not exist, so both install
      paths are so far proven against a catalog and packages built inside this
      repository

Every box in this list is ticked. That is the feature set of Core v1, not a
claim that the result has held a real housing cooperative's data: the opening
paragraph of this page still says no, and the pilot is the thing that will
change it.

## After v1

**v1.1**

- [x] Resource booking: laundry, common rooms, guest apartment, sauna. The board
      names what the house offers and how it is booked - by time slot, by the
      whole day, or by the night - and how much of it one apartment may hold.
      The name and the description are board-written free text that every
      resident reads on the calendar, and the name goes into the booking mail as
      well, so both are scanned for a personal identity number on the way in and
      on every later edit, with the refusal naming the field it was found in.
      Slots are generated on the association's own clock rather than stored, so
      a laundry room opens at seven on the two mornings a year that are 23 and
      25 hours long. The double booking is refused by the database itself,
      through a partial unique index that a cancellation releases. The allowance
      is counted at write time from the booker's own residencies, so joint
      holders of one apartment share it and a move-out bites on the day it says.
      A resident's calendar shows free, booked, their own or gone, and never who
      holds an hour; seeing that, and cancelling on somebody's behalf, is the
      board's own capability. A booking is confirmed by email to the resident
      who made it, and that resident is told when somebody else cancelled it -
      each in their own language, and sent after the booking has committed, so a
      mail server that is down cannot refuse a booking that was made. Bookings
      are in the data subject access report and are erased on the retention
      policy's clock, with a legal hold stopping it. Driven end to end through a
      browser against the production image, including the refusal a second
      household reads when it loses the hour and the allowance shared across one
      household
- [x] Event calendar with sign-ups: the event series the board arranges, with
      its category, its location and its sign-up settings; the recurrence
      rule - weekly, monthly or annual, with an interval and an end it has to
      state - and the occurrences written out from it as rows on the
      association's own clock, across both daylight saving changes and over
      month ends and the 29th of February; the write path with the personal
      identity number scan on publication, members-only unless the board
      publishes to the street, the refusal to move a date people are standing
      on, one date called off on its own and put back again as an act with its
      own record which signs nobody up who stood down while it was off, the
      board's list answering for a period of days rather than for the whole
      calendar, the `events:manage` capability and the audit entries; sign-up
      per occurrence with the places counted per date and a claim the database
      and a lock decide, withdrawal as a dated close that frees the place
      again, the register-call behind the managing capability with a person with
      protected personal data counted and never named, `events:attend` as a
      capability of its own, the data subject access report section and the
      sign-up purge with its legal-hold check; the calendar screen in two
      halves - what is coming up with the places gone per date and never who
      has them, whether a date has begun and which audience it was published to
      both decided by the server, a sign-up and a withdrawal whose count and
      control are read from one server answer so the two cannot disagree after
      a race, and the board's own half entering a series, publishing it to the
      members or to the street, moving the period it shows, calling one date
      off, putting one back and reading the register-call, with the personal
      identity number refusal naming the fields it was found in; and the public
      calendar page at /kalender with one address per event, a month at a time
      with plain previous and next links and no script at all, the dates a
      reader may see decided among the published ones by whether they carry a
      session and nothing else and no field on that page describing an audience
      at all, a draft on the calendar for nobody, an event kept for the members
      answered signed-out with the website's own not-found document byte for
      byte, how many places are gone beside a date and never who has them, and
      a calendar block the board can put on a page it writes; and the end-to-end
      suite that drives all of it through a browser against the production
      image - the board publishing one event to the street and one to the
      members from one field whose default is the members, a place taken and
      given up again with the row read again from the instance between the two
      acts, the last place going while somebody is looking at it and the count
      they are looking at catching up in the same breath, the register-call naming
      who is coming and never the person carrying protected personal data, and
      the street reading the public date on a page that runs no script, sets no
      cookie and asks no other company for a byte, while the members' event at
      its own address is answered as nothing at all

**Later, still free and in the core**

- [ ] General meetings: the notice (kallelse), the agenda, the voting register,
      proxies, real-time voting, and the link from a motion to the meeting it is
      taken up at - a motion still carries no meeting reference, because what
      decides which meeting takes an item up is the notice that states it.
      Motion intake itself is the Forms item
      below rather than this one. Postal voting is prohibited for a housing
      cooperative under BRL 9 kap. 14 §, and will never be built.
  - Landed: the meeting itself, its agenda, who was present and in what
    capacity, the written authorities somebody else's vote is exercised under,
    and each item's outcome as the counts the chair read out. The voting
    register (röstlängd) is derived when it is read and never stored: every
    member has one vote, so two apartments are one vote and joint holders of one
    bostadsrätt have one between them, a biträde is on the list and carries
    none, and an ombud's authority is measured against the meeting day rather
    than against the day it was registered. The four bylaws clauses BRL 9 kap.
    14 § leaves to the association sit with the instance settings, each
    defaulted to the statutory position - one member per ombud for a housing
    cooperative, not the three the general Act allows. Both new stores of
    personal data have a section in the data subject access report, and the
    proxy section answers for the member who gave the authority and for the
    ombud who held it
  - Pending: the board's screens for arranging a meeting, checking people in and
    reading the register; the notice on a delivery ledger; the link from a
    motion to the meeting it is taken up at; and real-time voting, for which the
    vote record exists with no voter recorded so a closed ballot
    (sluten omröstning) is representable without migrating the table the minutes
    are built from. Nothing casts a vote yet
- [ ] Comments on news items, then group and board chat. Comments first and a
      full discussion forum never: a forum is a product of its own, and a
      cooperative that wants one is better served by an integration with
      software built for it than by a second-rate copy inside this one. A
      comment is exactly as visible as the news item it sits on, and no comment
      is rendered on the public website - those pages read no session at all,
      so a thread there would be either anonymous or a login wall on a page
      that promises neither. The board can strike a comment through and cannot
      erase one, because what somebody wrote is a record of what was said.
  - [x] Comments on news items: the schema, the endpoints with the personal
        identity number guardrail on a resident's own text, moderation, the
        data subject access report section and the nightly purge with its legal
        hold, and the screen the house reads a notice and its thread on. The
        capability is a resident's rather than a member's, because answering a
        notice about the building one lives in is not the statutory right that
        membership carries. Moderation is the board's own site:manage, because a
        thread under a notice is part of what the association publishes, and it
        outlives the notice being taken down: publication decides who may read
        a thread and never who may act on one. A struck comment stays on the
        thread attributed exactly as before - a person with protected personal
        data is named to nobody either way - its text withheld from other
        readers and readable to the board and to whoever wrote it, and the
        screen renders that answer as the server gives it per reader rather
        than deciding it in the browser. A thread is read a page at a time from
        its newest end, so a reader opening a long one lands where the
        conversation is, and the comments before that page are a press away
        rather than quietly missing
  - [ ] Group and board chat
- [ ] Shared board mailbox
- [ ] Digital home folder for residents
- [ ] Forms: subletting applications, motions, key orders
  - [x] Motions to the general meeting: a member submits one in writing and the
        board works the queue it arrives in, recording that it has been received.
        The right is a member's, not a resident's (EFL 6 kap. 15 § via BRL 9 kap.
        14 §). The motion deadline is whatever the association's own bylaws set:
        the platform holds no default, a cooperative whose bylaws are silent has
        no recurring date of its own to hold, and the statute's own condition -
        that a member ask the board in writing in time for the item to be taken
        up in the notice - stands either way. It is stated rather than enforced:
        a late motion is still received, and nothing here records which general
        meeting takes one up, because that is decided by the notice that states
        the item and no notice is issued yet
  - [ ] Subletting applications
  - [ ] Key orders
- [ ] Simple finances: fee notices, debiting lists, SIE export. Never a
      bookkeeping engine of our own
- [ ] Charges to members: a one-off cost put on a named member or apartment -
      a key to the bike room, a replacement tag, a subletting fee, a repair
      charged on - with the amount, the date, the reason, the VAT treatment
      and whether it has already gone to the economic manager. The board
      records the charge and exports the list as CSV or PDF for whoever keeps
      the association's books. Open BRF holds the basis for the charge, not
      the ledger: it never records a payment and never carries an outstanding
      balance, because the accounting system is where a debt is settled and a
      second answer to "has this been paid" is worse than none. A charge ties a
      sum to a member or to an apartment, and an apartment leads back to the
      people holding it, so it sits in the service tier under the same access
      control, masking and audit log as the rest, and it is never public
- [ ] Reporting to Lantmäteriet's cooperative housing register
      (bostadsrättsregister). Not a single export but a standing duty: an
      initial submission of the existing apartments, then a notification of
      each event the cooperative is responsible for - grant (upplåtelse),
      transfer (övergång) and termination (upphörande) - per Lag (2026:484) om
      bostadsrättsregister, 3 kap. Each has a two-week window, but they do not
      all start from the same moment, and a transfer has more than one answer
      (3 kap. 3 §): the clock normally runs from the day the association
      decided on membership, but where the acquirer is already a member or
      falls outside the membership requirement it runs from the transfer
      itself, and so it does where the tenant-ownership passed to the
      association. Which is why the recorded membership decision date is
      nullable and an absent one is not a gap. The statute also assigns the
      report to a juridical person in defined cases. Liens
      (pantsättning) are registered by the lienholder, not the cooperative, so
      they are deliberately outside this feature. The exact per-event trigger
      and actor rules belong with the implementation, not this page. A missed
      notification can affect registration and a third party's protection,
      which makes this a legal duty rather than a convenience feature
  - Landed: the register now holds every date a report is computed from. A
    termination (upphörande) is a statutory-tier record of its own, on the two
    grounds bostadsrättslagen distinguishes, append-only in the database and
    beyond the application role's reach. A transfer carries the day the
    association decided on membership, which is the day its window opens and a
    date derivable from nothing else the platform holds. The association's
    authoritative property designation sits beside its organisation number,
    separate from the prose the board publishes to a broker. All three are
    recordable on the apartment register screen and written to the audit log.
    Each recorded date that opens a reporting window now becomes a dated duty in
    a statutory-tier ledger, written by the same transaction as the register
    event it is computed from, so the register write itself fails rather than
    leaving a deadline unrecorded. The two weeks are stated in the database as
    well as in the service, so no writer can enter a window that is not the
    statutory fourteen days, and each duty carries its own audit entry. A
    person's own duties are on their data subject access report, reached through
    the register events already on it. The board reads those duties on a screen
    of its own that groups them by what is owed, what has passed its statutory
    deadline and what has been reported, and every seat on the board is emailed
    in its own language when a window opens - queued after the register write has
    committed and best effort, so neither a mail server nor a job queue that is
    down can cost the association a deadline. Recording that an anmälan reached Lantmäteriet is an
    act with its own audit entry and no register row: the ledger is append-only
    and a discharged duty has no later state to reach there, so the log carries
    the day stated and the queue reads it back. The initial supply of the existing
    apartments is produced as a documented file plus a printable extract of the
    same rows, and it is the only place the platform writes a personnummer into a
    file - behind a capability of its own, with an audit entry naming every
    person whose number it carried and every column it has, with a protected
    holder's address deliberately withheld, and refused outright where the
    association has no record or no organisation number to be identified by
  - Pending: the report itself. Nothing here transmits anything to Lantmäteriet,
    and nothing can yet: the föreskrifter that Förordning (2026:898) 2 kap. 2 §
    and 5 kap. 1-2 §§ leave the technical interface to have not been issued, and
    the register is still being built (Lag (2026:485) 2 § and 10 §). The file the
    platform produces therefore has Open BRF's own columns, documented in
    docs/register-supply-contract.md, whose content follows the field list in
    Förordning (2026:898) 2 kap. as narrowed by that förordning's second
    övergångsbestämmelse. That document also lists every field inside the supply
    duty which an instance does not hold - the apartment's rooms, kitchen type
    and area, the association's postal address and its counts of buildings,
    dwellings and premises, a co-holder's share of one bostadsrätt, a holder's
    civil status, and a lienholder's identifier, address and priority number -
    together with why each is absent. The ledger also carries no duty whose
    window the statute runs from the event itself rather than from a separately
    recorded date: an upplåtelse (3 kap. 2 §), a transfer to somebody already a
    member or outside the membership requirement, and one where the bostadsrätt
    passed to the association (3 kap. 3 § andra and fjärde styckena). None of
    those is distinguishable from what the platform records today, and the
    statute also assigns some reports to a juridical person rather than to the
    association. A registered överlåtelse that is later hävd or återgången is a
    further anmälan (3 kap. 3 § tredje stycket) with nothing recording it
  - Not modelled, and needed before a report can be rendered: Förordning
    (2026:898) 2 kap. 4 § andra stycket reports fastighetsbeteckning together
    with taxeringsenhetsnummer and fastighetstyp, in place of the association's
    lagfarts- och tomträttsinnehav, where its buildings stand on land it neither
    owns nor holds with tomträtt. The designation has a field; the other two do
    not. Whether the condition is met is answerable from the association facts,
    which record whether the land is owned or held on a site leasehold

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
- [ ] Advanced finances: everything that carries a charge or a fee out of
      Open BRF and into somewhere else - posting to Fortnox and Visma,
      autogiro and bankgiro files, payment reminders, a collections
      integration and an approval step before a charge leaves. Recording a
      charge and exporting the list is free and in the core, under Charges to
      members; what is paid is the delivery, which is where Apteo's accounting
      and payment agreements are
- [ ] Advanced booking, maintenance planning, broker and property manager
      packages

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
