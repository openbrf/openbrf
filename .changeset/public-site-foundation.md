---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Serve the association's own public pages at the root, and move the application
under `/app`.

The address a housing cooperative gives out now belongs to that cooperative's
own website. A page is stored as a title and a versioned list of blocks rather
than as markup, so the renderer decides what a block becomes: a block type it
does not know is skipped, and there is no block that can carry a script or an
address on another host. The API renders the page as plain HTML, styled by the
active theme - the token values, the typefaces and the association's own accent
are assembled on the server and inlined, because the page runs no JavaScript to
assemble them with. The typefaces are served from the instance itself, and the
content security policy names no script source at all, so a public page runs
nothing, sets no cookie and fetches nothing from any other host. That is also
why the site needs no cookie banner.

A page can be marked member-only. Anyone signed in reads it; everyone else gets
the same not-found document, byte for byte, that an address with no page behind
it gets - so a visitor with no account cannot learn from the refusal that the
page exists. Reading the session never writes one back: no response from the
website carries a cookie. The public rendering path reaches neither the
statutory registers, the address book nor the encryption layer, and the
integration suite holds it to that by scanning every page it serves for the
shape of a personal identity number.

Finishing the setup wizard writes the association one page, in the
cooperative's own language, so a claimed instance answers its address with
something. An instance claimed before this change keeps a not-found at the root
until a page is created; the page editor is a later change.

The application is served under `/app`, and everything that mints a link into
it now says so: the emailed activation link, the two email templates that point
at the application, the sign-in link on the website and the landing page after
a sign-in link is verified. An unclaimed instance still sends every visitor at
the root to the setup wizard.
