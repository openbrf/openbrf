---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Give a page on the association's website one status, let the board choose the
front page, and make a page's address from its title.

A page is now a draft, members only or public, chosen in one place in the page
editor and written when the page is saved. It replaces the published flag and
the visibility beside it. The upgrade keeps who can read every page: a published
public page is public, a published members' page is members only, and an
unpublished page is a draft. When it was first published is kept.

The front page is chosen with "Use as front page" on a public page, and
arranging the menu no longer changes it. There is one front page at a time, and
choosing another replaces it. The front page cannot be made a draft, made
members only or deleted until another page is chosen. The upgrade chooses the
page the website's address served the day before, so an upgraded site looks the
same. An instance with no public page has no front page, and its address
answers as it did.

A new page needs only a title. Its address is made from the title, with å, ä
and ö read as a, a and o and a number added when another page has it, and moves
with the title until the page is first published. The address can be written by
hand under "Advanced" in the page editor. Every page that exists when you
upgrade keeps its address.

For API clients: `POST /api/site/pages/:id/publish` and `/visibility` are
replaced by `/status` (`{ "status": "DRAFT" | "MEMBERS_ONLY" | "PUBLIC" }`), and
`/front-page` chooses the front page. A page carries `status`, `frontPage` and
`slugFollowsTitle` in place of `published` and `visibility`, and `slug` is
optional when a page is created or saved. The actions `page_set_status` and
`page_set_front_page` are new; `page_publish` and `page_set_visibility` are
deprecated aliases of `page_set_status`, which refuses their old input with the
schema it takes instead. `page_create` still accepts `visibility`, deprecated
and ignored, and makes a draft. ADR 0026 records the model.
