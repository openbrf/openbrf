---
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
"@openbrf/api": minor
---

A board member can now see the application as a resident sees it, in a resident
preview. "View as a resident", beside their name in the band and at the foot of
the phone menu, starts it. The resident preview narrows what the application
offers to what a resident and a member are
granted: the board's section, the board's line on the overview, the board's
signs and the board's controls on the house's pages are gone, the archive leaves
out the board's documents, the feed leaves out the posts addressed to the board
and to the administrators and the board's way of writing, the issue report form
leaves out the board's internal issue types, and the phone bar is a resident's.
The posts and comments that stay, the board's published news to the whole house
among them, are shown as a resident sees them, in the feed and in the comments
under the news: without the strike-through and the must-read list, without
earlier versions of what somebody else wrote or an issue report made from
somebody else's post, and without struck text or the status of an issue report
that is not the reader's own. The report to the board, which a resident is
offered on a post to the whole house, is not offered in the strike-through's
place, because the server refuses it to a board member there. A bar under the
band says the preview is on, on every page, and "Stop" in it ends the preview.

A post's issue report in the feed now says whether the reader made it, so the
preview can tell the reader's own issue report from one shown because the
reader handles issues.

Opening any page under `/board` ends the preview before the page loads, and that
page says why. Signing out ends it too. The preview lasts as long as the browser
tab: it is kept in the tab's session storage, never on the server, and the
server keeps answering every request on the account's own capabilities, so the
preview changes what is offered and never what is allowed.

It is offered to an account that sees more than a resident and holds some of a
resident's grants, which is a board member and the administrator. The property
manager, who holds none of them, is not offered it.
