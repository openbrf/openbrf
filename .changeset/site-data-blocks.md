---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the four remaining insertable blocks to the association's website: the
document archive, the board, the association's own facts, and questions and
answers.

Three of them carry nothing at all. What each one shows is read when the page is
rendered, against whoever is reading it, so one stored page reads correctly for
a visitor with no account and for a member without the page knowing which of
them arrived. A document taken off the public shelf this morning is off the page
this afternoon, a consent withdrawn today takes a name off it today, and a fee
policy corrected on the board's own screen is corrected everywhere it stands -
none of it an edit to a page.

A document list follows the archive rather than the page it sits on. The
archive already decides who may read a document, per document, and the block
asks it with the reader's own account rather than with "is somebody signed in":
a resident who is not a member is offered the public shelf, because the archive
gives every document its own audience and the minutes and the annual report are
kept for the members unless a board publishes one deliberately. The board's own
shelf is on no page at all - every serve of one of those files is written to
the audit log and gated by a capability, and the website is the one surface in
the product that has neither, so a link to one would be an invitation nobody
reading the page could follow and a hint about what the board holds. The board
reads that shelf in the archive, signed in as the board. A block can be
narrowed to one binder, and one that names a binder nothing is filed in renders
as nothing rather than as an empty heading.

A board roster publishes a name and an elected position, and nothing else. A
person appears only with their own recorded publication consent for exactly that
scope - agreeing to a photograph is not agreeing to this - and a person carrying
protected personal data is never published, whatever they have consented to,
because publication is what that protection exists to prevent. Somebody who has
withdrawn a consent and somebody nobody has asked are the same answer to a page:
absent, rather than masked or initialled. The decision is made in one place,
outside the website's own code, and the website is handed the answer the way it
is handed a menu - so there is no branch in the rendering that could name the
wrong person, and no query in the website that could reach a resident's details.
An association whose board has not been asked for its consents publishes no
roster, and the block then renders as nothing.

The association facts are the ones the broker information page is generated
from, rendered by the same code onto a page the board arranged itself. One
account of the association rather than two that could drift, and a question
nobody has answered is on neither.

The FAQ is the one block with content of its own, which is why it
needs no screen behind it: a FAQ is the board's own writing about its own house,
written on the page it is published on. It renders as a description list, so a
screen reader announces each question with its answer, and every answer is on
the page rather than folded away - it is a housing cooperative's FAQ, and it has
to survive being printed and searched.

The board inserts all four from the page editor, and the two that have nothing
to configure say what they will publish: a roster is empty until the consents
have been recorded, and a fact nobody has answered is not on the page. Nothing
about the website changes otherwise. It still runs no script, sets no cookie and
fetches nothing from anybody else, a document is fetched from this instance's
own media route by the id of the stored file, and a page carrying a personal
identity number is still refused publication - now including one typed into a
question or an answer.
