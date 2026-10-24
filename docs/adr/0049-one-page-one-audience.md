# ADR 0049: One page, one audience

Date: 2026-10-19

## Status

Accepted. Replaces the board zones that #378 and #385 put on the house's
screens.

## Context

A board member is nearly always a resident as well. The application served
both of their roles from the same screens: the bookings screen held the
resident's calendar and form, and under them a zone signed with the board's sign ("Board") with the
whole calendar and who held which hour. Issues, motions, subletting, keys,
events, the archive, the apartment binder and the feed had the same shape, and
the overview opened with the board's queues ("To handle") above the
resident's own panels.

Each zone was clearly signed, but the screens around them were not clear:

- **Two audiences on one page.** A board member reading their own laundry week
  scrolled past the board's calendar, and a resident's screen was described in
  DESIGN.md with a board half they would never see.
- **Two orders.** DESIGN.md put the resident first on a shared screen and the
  queue holder's queues first on the overview. Neither order was wrong
  for the screen it governed, and together they meant a board member could not
  predict where their own work stood.
- **Unsigned board pages.** Thirteen pages only the board reaches carried no
  sign at all, and the band's section signs are not shown below 1024px. On a
  phone nothing on those pages said whose they were.
- **Board pages outside the board's section.** The band's board section
  was meant to hold only what no resident is offered, yet the general meeting
  sat under the association's section, plugins and connected apps under
  settings, and the board halves of nine modules inside house pages.

A three-position view switch (everything, as a resident, as the board) was
considered. "As the board" would have been the board's pages, built as a filter
on every screen rather than as pages, and "everything" would have kept the mixed
screens it was meant to cure.

## Decision

1. **One page, one audience.** The board's work lives on the board's pages,
   every one of them under `/board` and listed in the band's board section.
   A house page (under the association or the house) carries no board zone. What a zone
   held becomes a page of its own, named by the act as the zone was: "Handle
   issues", "Manage bookings".
2. **An act done in place stays in place.** Editing a document on the archive's
   shelf and striking a comment under a news item are done to the thing a
   resident is reading, and stay where they are, led by the compact board
   sign. They are the only board controls a house page keeps.
3. **The overview is the house's notice board.** The queues move to the
   board's front page ("To handle") at `/board`. An account that works a
   queue gets one signed line above the overview's panels saying how much is
   waiting, with the way there.
4. **The front page is there for an account with two or more board pages.** An
   account with one - the external property manager, whose one page is the
   issue queue - has no front page: its section is that page, shown as the
   page's own sign under the band's one-destination rule, and its phone bar's
   middle slot opens it.
5. **The section is grouped by the kind of work,** one level: the front page
   first, then queues, register, publish, finances and data protection
   (`nav.boardGroups.*`). A group the
   account has one page in shows that row without a heading.
6. **Every board page carries the sign on its heading,** in the h1 and before
   the title, with one sentence saying who sees it. The issue queue is signed
   "Board and property manager" (`boardPage.issueHandling.sign`), because the property manager works it and must
   never read "Board" over their own queue.
7. **The phone bar of an account with board pages is the overview, its first
   board page and the feed.** The first board page is the front page where
   there is one, otherwise the one page the account has. Residents keep the
   overview, issues and bookings.
8. **A board member can see the application as a resident does,** for the
   length of a browser session (the resident preview). The
   client narrows the capabilities it offers from to a resident's and a
   member's grants, so the section, the bar slot and every sign go with them.
   The feed's answers are narrowed in the client too: the audiences Styrelsen
   and Administratörer and their posts go, and each post and comment that stays
   carries what a resident is shown, without the board's strike-through and
   must-read list, and with struck text, earlier versions, issue reports and
   their status only where the reader wrote or reported it. The report to the
   board is not offered in the strike-through's place: the server refuses it
   to the board in Alla. Opening any
   `/board` address ends the preview, since a page under `/board`
   is the board's by definition. It is never stored on the server; the browser
   keeps it in the tab's session storage, which closing the tab clears, and the
   server keeps refusing exactly what it refused.
9. **The address book is the board's page.** The resident directory the same
   address answered a resident with has no house page, and giving it one would
   be a product decision of its own. The fallback to the resident directory
   stays for now and goes with the second pull request.
10. **No redirects.** Nobody uses the application yet, and old addresses simply
    stop existing.

The capability model does not change. Which page an account is offered is
read from the capabilities `GET /api/me` answers, as every screen already does,
and the API refuses what it refused before.

## Consequences

- **A house page is the same for everybody who lives here.** A board member
  reading their own bookings reads what their neighbour reads.
- **The board's work is in one place,** grouped in the band and gathered on the
  front page, and every page of it says whose it is on a phone as on a laptop.
- **One exception stays visible.** The archive's shelf shows a board member
  their edit control under its sign, and a board-only document on the shelf
  carries the audience sign "Board" beside it. The two signs mean
  different things - who may read the document, and whose control it is - and
  are accepted on that one shelf.
- **The queues cost one read each, twice.** The overview's line sums the same
  reads the front page makes, one per queue (nine queues today, fewer for an
  account that works fewer). A count endpoint would do it in
  one; it is not needed yet.
- **Old addresses fail.** A bookmark to `/address-book` or `/import` finds
  nothing. That is acceptable before the first association uses the
  application, and would not be after.
- **The resident directory has no house page.** Until the second pull request
  removes the fallback, a resident who opens `/board/address-book` is still
  answered with the resident directory, with no sign, because the board's view
  of that address refuses them. After it, the resident view's code stays in the
  tree, unreferenced from the router, for the day a house page for it is
  decided.
- **The work lands in four pull requests.** The issue queue and bookings move
  first, with the front page, the overview's line, the grouped section and the
  signs. Motions, subletting, keys, events, the archive, the binders, the
  reported posts and the general meeting follow, with the board mailbox, fees,
  charges and data protection, which until then keep their addresses; then the
  preview, then the association's settings, plugins and connected apps.

## Revisit triggers

- **An association asks for a board member's own view of the house with the
  board's work beside it.** That is the mixed screen this record rejects; the
  preview is the answer to "what does a resident see", not to that.
- **The front page's reads become slow.** One read per queue (nine today) for
  one number on the overview, and again on the front page, is the point to add a
  count endpoint.
- **A module gains a board act done in place** beyond the two kept here. A
  third is the point to ask whether in-place acts are still exceptions.
