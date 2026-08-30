---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the broker information page, generated from facts the board records about
the association.

A broker asks every housing cooperative the same questions before a sale, and a
board that has no page to point at answers them by email one at a time. The
board records them once instead: the property designation, the year the
building went up, whether the association owns its land or holds it on a site
leasehold, how the fee is set and what it covers, the transfer and pledge fees
and who pays them, whether a legal person may be a member, parking, storage,
and the renovations of note. The website serves those facts at /maklarinfo,
and at /broker for a cooperative that keeps its site in English.

The page is generated from the recorded facts and from nothing else. Beside
them it carries the association's name and organisation number, which are the
cooperative's own legal-person facts, and the number of apartments, which is a
count. That count is the one value on the page no board member typed, and it is
an aggregate over the apartment register: a number of rows, never a row.
Nothing personal and nothing per-apartment reaches the page, and nothing could:
the code that renders it imports neither the member register, the address book
nor the encryption layer, so there is no path from this page to a resident's
details rather than merely no query written today. The paid transactional
broker extract is a different product for exactly that reason - it needs
per-apartment facts this page may not hold.

A question the board has not answered is not on the page. There is no empty
label, no dash and no "not recorded": the person reading the page cannot go and
fill the gap in, so raising the question at them is worse than leaving it out,
and a whole group whose facts are all unanswered loses its heading with them.
Clearing a fact takes it off the page again in the same way. A yes or a no is
published as the sentence it means - "the association owns the land" rather
than a tick - so it stands on its own wherever a broker copies it to. And the
board's form has a third answer beside yes and no, because "the board has not
decided" is a real state and an unticked box would publish a decision nobody
made.

The page exists from the moment the feature ships. An association that has
recorded nothing gets a page carrying its name and organisation number rather
than an address that answers "no such page" until somebody saves a form - a
broker who was sent the address once has no reason to try it twice.

The association's menu can point at it. The broker information page is one of
the destinations the menu editor offers, and it is offered for real rather than
reserved: the page is public and no setting turns it on, so an entry a board
adds is an entry every visitor can follow, signed in or not. The page carries
the same menu, header and footer as the pages the board writes, by the same
code, so the website has one chrome and not two.

Everything on the page is free text a board member typed, published at an
address anyone can open, so a personal identity number in any of the fields is
refused on the way in, exactly as it is on a page. The refusal names the field
and where in it the number sits, and never the number. The page is answered in
the association's own language rather than the visitor's, because the facts are
stored as the board wrote them and are never translated; a Swedish fee policy
under an English question would be a document whose language is only half
declared. Like every page on the association's website it runs no script, sets
no cookie and fetches nothing from a third party.
