---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the menu on the association's website: a top level, one level under it, and
a visitor shown only what they could open.

The board arranges the menu itself. An entry points at one of the association's
own pages, at a page the platform generates - the news index, the broker
information, the form for asking the board for an account - or at an address
somewhere else, and it hangs either at the top level or under one entry that
does. An entry taking a page takes the page's own title unless the board writes
something of its own, because a menu is written to fit the width of a menu: a
borrowed title is cut to that width, and one the board typed is refused past it
rather than saved as words nobody wrote.

Which entries a visitor is served follows from what each one points at, and
never from anything stored on the entry. A page kept for the members is not
named to somebody with no session: the entry is absent from their menu rather
than shown and refused, so the navigation cannot become the thing that tells
them the page is there - which is the argument the byte-identical not-found
document already rests on, applied to the one part of the chrome that would
otherwise list every address the association has. The not-found document itself
carries the menu a visitor with no account gets, whoever asked for it, so the
refusal stays one document for everybody. An entry for a generated page is left
out while that page does not exist or its feature is switched off, so a menu
survives an association changing its mind, and the account-request entry is
offered only while the board takes requests and only to somebody who has no
account yet.

The menu is also the ordering of the site. The address at the root serves the
menu's first page entry, so there is no separate home-page setting that could
disagree with the menu, and an association that empties its menu still has a
front page: the lowest-ordered published public page, as before. An instance
that already had pages gets one menu entry per published public page in the
order the pages sat in, so its front page does not move; a cooperative claiming
a new instance gets the entry for its first page written beside the page.

The dropdown needs no script, because the website runs none. On a narrow screen
the second level is simply a list under its parent; on a wide one it is revealed
by the pointer and by keyboard focus reaching the group, so tabbing onto an
entry opens it and the next tab lands inside. The parent stays an ordinary link
in both, rather than becoming a control that is also a link, and every target
keeps the 44px touch height the rest of the product uses. An entry pointing
somewhere else is a text link and nothing more - https only, and nothing is
fetched from the other host while a page is being read.
