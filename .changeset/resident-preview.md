---
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A board member can now see the application as a resident sees it. "View as a
resident", beside their name in the band and at the foot of the phone menu,
narrows what the application offers to what a resident and a member are
granted: the board's section, the board's line on the overview, the board's
signs and the board's controls on the house's pages are gone, the archive leaves
out the board's documents, the feed leaves out the posts of Styrelsen and
Administratörer and the board's way of writing, and the phone bar is a
resident's. A bar under the band says the preview is on, on every page, and
"Stop" in it ends the preview.

Opening any page under `/board` ends the preview before the page loads, and that
page says why. Signing out ends it too. The preview lasts as long as the browser
tab: it is kept in the tab's session storage, never on the server, and the
server keeps answering every request on the account's own capabilities, so the
preview changes what is offered and never what is allowed.

It is offered to an account that sees more than a resident and holds some of a
resident's grants, which is a board member and the administrator. The property
manager, who holds none of them, is not offered it.
