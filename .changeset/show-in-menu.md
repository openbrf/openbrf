---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Put a page in the menu with one switch, and arrange the menu by dragging.

Every page in the website's page list, the association's own and the built-in
ones, has a "Show in menu" switch. Turning it on adds an entry last on the top
level of the menu with the page's title as its text; turning it off takes the
page's entries out of the menu, and what hung under one stands in its place.
The switch acts at once and needs no save. A visitor sees the entry once the
page is open to them, as for any entry.

The menu screen is arranged by dragging. An entry is dragged up or down to move
it, and sideways under the entry above it to make it a dropdown item; the menu
keeps its two levels. Each row has the same moves as buttons - up, down, into
the dropdown above and out of it - which is what a keyboard and a screen reader
use, and the screen says in the board's language where the entry went. An entry
whose form is open can be moved, and keeps the changes not yet saved. While an
entry is being removed, it and what hangs under it stay where they are and
nothing can be moved in under it, so the removal takes the dropdown the board
saw when they removed the entry. After a move that did not go through, or an
addition or an edit that got no answer, the screen reads the menu before it
sends a removal, and sends it only if the entry's dropdown there is the one
the board saw; otherwise the entry stays, the board is told, and the menu is
read again. Pages that are not in the menu yet are listed under "Add a page",
one button each, and the form below it is for a link to an address elsewhere.

For API clients: `POST /api/site/pages/:id/menu` with `{ "inMenu": boolean }`
puts a page in the menu or takes it out and answers with the page, which now
carries `inMenu`. `POST /api/site/menu/arrange` takes the whole menu in reading
order, each entry with the top-level entry it hangs under, and writes both
levels in one step. It is refused with `menu-changed` when the menu no longer
has the entries it was sent, and with `nesting-too-deep` for a third level.
