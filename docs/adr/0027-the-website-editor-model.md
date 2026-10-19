# ADR 0027: The website editor model

Date: 2026-10-18, amended 2026-10-19 (how the built-in pages are stored)

## Status

Accepted. Amends [ADR 0006](0006-the-page-block-model.md) on how a page is
published and which page the root serves.

## Context

The association's website has to be something a board member with no technical
background can build on their own. As it stood, building it asked them to know
things a person who has never run a website does not know:

- A page had two settings for one question. `published` said whether anybody
  could read it, and `visibility` said who could once it was published. A draft
  still had an audience, which did nothing until the day the page was published
  and then decided who read it.
- The front page was the menu's first page entry. Dragging an entry to tidy the
  menu changed what the website's own address served, and nothing on the screen
  said so.
- Every page needed an address typed by hand, in lowercase letters, digits and
  hyphens, before it could be created.

The board decided how the website should be built instead, in ten points. This
ADR records the model those decisions need. The work lands as eight pull
requests, and this record covers the parts the later ones build on, so that each
of them extends a model rather than inventing one.

## Decision

### One status for a page

A page has one `status`: `DRAFT`, `MEMBERS_ONLY` or `PUBLIC`. It replaces
`published` and `visibility` on `Page`. The four states the two columns could
hold become the three the board meant:

| published | visibility | status         |
| --------- | ---------- | -------------- |
| true      | PUBLIC     | `PUBLIC`       |
| true      | MEMBER     | `MEMBERS_ONLY` |
| false     | PUBLIC     | `DRAFT`        |
| false     | MEMBER     | `DRAFT`        |

`publishedAt` stays as it is: it is when the page was first published, and a
page taken down keeps it.

The status is set by its own act (`POST /api/site/pages/:id/status`,
`page_set_status`) and never through the ordinary save, for the reason ADR 0006
gives for publishing. The audit log reads the same across the upgrade: a page
put on the website or taken off it is still `PAGE_PUBLISHED`, and a published
page moved between the members and the street is still
`PAGE_VISIBILITY_CHANGED`. The publication guardrails run whenever the new
status is `MEMBERS_ONLY` or `PUBLIC`.

News items and events keep `PageVisibility` with a `published` flag beside it.
Their publication is a separate act with consequences of its own - a news item
can be mailed when it is published - so the two halves are still two questions
there.

The `page_publish` and `page_set_visibility` actions each set half of what is
now one choice. Their names are carried onto `page_set_status` as deprecated
aliases rather than reused for a new shape (see `docs/actions.md`): a client
holding an old tool list is refused with the schema it should have sent instead
of having its call read as something it did not mean. `page_unpublish` keeps
its name and shape. `page_create` keeps its name and still accepts the
`visibility` it was published with, deprecated and ignored: a new page is a
draft nobody but the board reads either way, and its audience is chosen when
its status is set.

### An explicit front page

The front page is a setting on the page, `Page.frontPage`, chosen with "Use as
front page" in the page's editor (`POST /api/site/pages/:id/front-page`,
`page_set_front_page`). The menu's order no longer decides it.

- **One at a time.** A partial unique index allows one row with `frontPage`
  set. Choosing a page clears the previous front page in the same transaction,
  under an advisory lock so two boards choosing at once take turns rather than
  meeting the index as a fault. The choice is recorded as
  `PAGE_FRONT_PAGE_CHANGED`, naming the page it replaced.
- **Always public.** A CHECK refuses a front page whose status is not `PUBLIC`.
  The root is the one address on the website that never asks who is reading,
  so a draft or a members' page there would be the not-found document for
  every visitor without a session. The write service refuses to set the front
  page to `DRAFT` or `MEMBERS_ONLY`, or to delete it, until another page has
  been chosen, and says so (`front-page`). Only a public page can be chosen
  (`front-page-not-public`).
- **No way to clear it.** The board chooses another page instead. An
  association's front door is a page the board chose.
- **A fallback while none is chosen.** An instance with no front page answers
  the root as it did before: the menu's first page entry anybody may read, then
  the lowest sort order among public pages, never the privacy notice.
- **The migration keeps the site as it was.** It chooses as the front page the
  page the root served the day before - the same question, in the same order -
  so an upgraded website looks the same and the menu stops deciding from then
  on. The setup wizard's first page is written as the front page.

### An address made from the title

A page's address (`slug`) is made from its title by `slugFromTitle` in
`packages/shared`: lowercase, å, ä and ö read as a, a and o, other letters
stripped of their marks, every other run of characters one hyphen, at most 80
characters. A title with no letters or digits gives `sida`. The board's screen
and the API both read the rule from there, so the address shown while the title
is typed is the address the API stores.

A reserved address, or one another page holds, is given the next free number:
`nyheter-2`, `styrelsen-3`. Refusing it would ask the board to solve a problem
the product can. A numbered address stays while the title gives the same one,
even after the page that held the plain one is gone: a save of the body alone
must not move the address the editor showed. Only a new title gives a new one.

`Page.slugFollowsTitle` says whether a rename still moves the address. It is
true for a new page and is cleared for good the first time the page is
published - from then on somebody may have the address, in a bookmark or on a
notice in the stairwell, and a rename must not break it. It is cleared too when
the board writes an address by hand, under "Advanced" in the page's editor,
which is the only place an address is typed. Every page that exists when the
migration runs keeps its address: each was typed by the board.

### Built-in pages

The news index, the calendar, the broker information page and the account
request form are listed with the association's own pages as built-in pages, and
are put in the menu the way any page is. They stay generated: the product
writes what is on them, the board writes nothing there, and their addresses
stay reserved.

**Stored as pages.** Each is a row in the page table with `Page.builtIn` set to
`NEWS`, `CALENDAR`, `BROKER_INFORMATION` or `REQUEST_ACCOUNT`, one of each by a
unique index, written by the migration on every instance. A row rather than a
list in code, so that the board's list and the menu have one kind of page to
point at: a menu entry for the news index is a `PAGE` entry naming the page's
id, exactly as one for a page the board wrote is, and the "Show in menu" switch
and the menu screen of website 6/8 need nothing of their own for them.

- **Its body is empty and its address is fixed.** What stands on a built-in
  page is rendered by its own route from what the instance holds - the news
  items, the events, the association facts, the account request form - so the
  write service refuses a body for one, and an address other than the one it
  is served at, with `built-in`. The address is stored on the row like any
  page's: `nyheter`, `kalender`, `maklarinfo`, and `app/request-account` for
  the form, which is the application's rather than the website's. It is the one
  stored address that is not a single path segment, and the page route never
  reads it: a built-in page is served by its own route, and the page lookup
  refuses every reserved or unshaped address before it reads a row.
- **Its title is the board's.** The title is what a menu entry for the page
  borrows when it is added without a label of its own, so the board can rename
  the news index "Aktuellt" for its menu. It does not change the heading the
  page is rendered with, which stays in the visitor's language. The migration
  titles the pages in the association's language, and the setup wizard titles
  them again in the language it is finished in, unless the board has saved one
  since.
- **Always public, never the front page, never deleted.** A CHECK holds a
  built-in page to `PUBLIC`, to `frontPage` false and to an address that does
  not follow its title. Public because what each visitor reads there already
  follows each news item's and event's own audience, and because the address is
  linked from mailings and from blocks on other pages: a news index that could
  be made a draft would turn every one of those links into the not-found
  document. Leaving a built-in page out of the menu is how the board leaves it
  out. Not the front page, because the root serves a page the board wrote and a
  built-in page's row has no body to serve; for the same reason the root's
  fallbacks pass them over. And not deleted, because the route answers whether
  or not the row is there, so removing it would take the page out of the
  board's list and the menu and nowhere else.
- **The account request form's entry follows the setting.** It is offered only
  while the board takes account requests and only to a visitor with no
  session, as its `GENERATED` entry was. The other three are offered to
  everybody.

**The menu has two kinds of entry.** `GENERATED` and `generatedKey` are gone.
The migration points every `GENERATED` entry at the built-in page its key
named, keeping its label, its place and what hangs under it, so every menu
renders exactly as it did the day before, which a migration test asserts on a
menu holding every key at both levels. An entry naming a key no version offered
could only have been written by hand and was never rendered, and it is removed
with what hung under it. A page the board wrote at `nyheter`, `kalender` or
`maklarinfo` before those addresses were the product's could never be opened -
the route outranks the page - and is moved out of the way to an address made
unique by its id.

The `menu_generated_keys` action is retired rather than kept as an alias: it
answered a list of keys nothing accepts any more, and a caller finds the
built-in pages with `page_list`, where each row says `builtIn`. A caller still
holding the old `menu_create` schema is refused with the current one.

### One registry for blocks

A block type is defined once, in a block registry: its write schema (strict),
its reader (total), its renderer, and what the editor needs to offer it - its
name, what a new one holds, and its fields. Before it, a block type was spelled
out in four places that had to agree: the API's union and parser, the renderer,
the web client's union and the editor. ADR 0006's safety argument rested on
adding a block being "a visible change in two files"; it rests on the registry
entry instead, which carries the reader and the renderer together. A type nobody
has registered still renders as nothing, and the parser stays total on read and
strict on write. Website 3/8 built it, and ADR 0006 records it as built.

Plugin blocks (website 7/8) register through the same registry. They render on
the server, their output is sanitised before it reaches the page, and a plugin
that throws or is removed hides its block rather than breaking the page.

### Columns, one level deep

A columns block holds two or three columns, and each column holds a list of
blocks. A column may not hold a columns block, or any other block that holds
blocks: one level of nesting and no more. The write schema refuses a deeper
body, and the reader drops a nested layout block rather than rendering it, as it
drops any block it does not vouch for. Columns are additive, so the body stays
at version 1. Website 4/8 builds them with the other layout blocks.

### Drag and drop, and its keyboard equivalent

The visual editor (website 5/8) and the menu screen (website 6/8) reorder by
dragging, with `@dnd-kit` (MIT). It is chosen for its keyboard sensor and its
screen reader announcements, which make a drag something a person without a
pointer can do. Every drag keeps a plain equivalent beside it - the move
buttons both screens have today - so nothing depends on the drag working. This
is editor code in the application only: the public website stays server
rendered and runs no script.

## Consequences

- **A board member never types an address** unless they choose to, and the
  address of a published page cannot change by accident.
- **Rearranging the menu cannot change the front page.** The front page changes
  only when the board chooses another, and that is recorded.
- **The front page cannot be taken down, closed to the members or deleted
  directly.** That is one more step for a board that means it, and the screen
  says which step.
- **An HTTP client of the page routes has to change.** `/publish` and
  `/visibility` are replaced by `/status`, and the page view carries `status`,
  `frontPage` and `slugFollowsTitle` in place of `published` and `visibility`.
  The actions keep working for old clients through their aliases, or refuse
  them with the schema they should send.
- **A menu client has to change too.** A menu entry is a `PAGE` or an
  `EXTERNAL` one, and carries no `generatedKey`; an entry for the news index
  names the built-in page's id. Every page carries `builtIn`, and a client that
  lists pages to write into them - placing a block, say - leaves the built-in
  ones out.
- **A built-in page cannot be hidden from the street.** A board that wants no
  calendar keeps it out of the menu; the address still answers, with the dates
  anybody may see.
- **News and events keep the older shape.** A page and a news item are
  published differently, which is visible to anybody reading both write
  services.
- **A numbered address can look odd** - `styrelsen-2` - where two pages share a
  title. The board can write another one under "Advanced".

## Revisit triggers

- **A board asks to clear the front page without choosing another.** The
  fallback exists and would serve the root; refusing is a decision about what
  an association's front door is, not a limit of the model.
- **News or events need a third audience.** Moving them onto a status like a
  page's is the change that would follow.
- **Nesting deeper than one level is asked for.** The one-level rule is what
  keeps a page readable on a telephone and the parser simple; a request for a
  second level is the point to reopen it.
- **The drag library stops being maintained or loses its keyboard support.**
  The move buttons stay, so replacing it is a change to two screens.
