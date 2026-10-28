---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/plugin-sdk": minor
---

The board now consents to a plugin's resident routes (ADR 0051), and the host
serves a resident route only where it has.

- **The consent screen** lists a plugin's resident routes beside its
  permissions, in Swedish and English: that any resident the address book
  lists to the plugin can use them without a board seat, each route's title
  opening to its address, that the plugin can tell which resident is asking
  and read and write its records about people there, other residents' records
  included, that it cannot read the register there, and that what it shows a
  resident of other residents' records is the plugin's choice. The titles are
  the catalog's, read from `residentRoutes` in a version 3 index entry.
- **`openbrf plugin add`** prints the same section, each title with its
  address, before it installs, and echoes the routes it printed.
- **The install records** the paths of the resident routes the board
  consented to, from the consent screen and from `openbrf plugin add` alike,
  and the install's audit entry names them. The install request echoes the
  routes with their titles, and an entry whose routes changed since the screen
  was drawn is refused as a consent mismatch.
- **A new finding, `resident-routes-widened`.** A version that declares a
  resident route the board has not consented to, or moves one to cover a path
  it did not cover, is not loaded until the board installs it again. A route
  inside a consented one, or a route dropped, loads. A plugin installed before
  this release consented to none, so one that declares resident routes is
  refused until the board installs it again.
- **The navigation** offers the view of a plugin with resident routes, in the
  section it names, to an account that holds a residency today, and to nobody
  else: a resident without a board seat is offered it, and a board member or
  administrator who does not live in the house is not. A plugin without
  resident routes is offered on its routes' floor as before.

The curated catalog address an instance reads is still that of version 2, so a
plugin with resident routes is offered from an index of version 3 named in
`OPENBRF_CATALOG_URL` until the curated catalog publishes one.
