---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Let the board write the association's own website, with the publication
guardrails inside the write path.

Pages are edited from the application: paragraphs whose text can carry emphasis
and links, headings, and pictures served from the instance's own origin. A page
is written before it is meant to be read, so it is a draft until it is
published, and it is either public or readable by anyone signed in - a page
nobody may read is still answered exactly as one that does not exist. Writing
the website is a capability of its own, granted to the board: publishing in the
cooperative's name is what a board does, while how the instance is configured
stays with an administrator. Reading the website needs no capability at all,
which is what a public website is.

What is stored is a list of blocks and never markup. The renderer decides what a
block becomes, so no page can carry a script or an address off this instance
into a browser: a link is limited to an ordinary web address, an email address
or a page on this site, and a picture is stored as the identity of a file rather
than as a URL. The editor is a mapping onto that format rather than a format of
its own - what it produces is read out paragraph by paragraph on every change,
and its own document is never stored - so a heading, a table or a colour pasted
from a word processor is gone before it reaches a block. A body written by a
later version renders as less on an older instance rather than as something that
version cannot vouch for.

The preview is the website's own renderer, given the draft and shown in a
sandboxed frame. There is one renderer, so what the board approves is what a
visitor is served.

Three refusals guard what a page can carry. A personal identity number anywhere
on a page - in the title, in the text, in a picture's description - refuses to
be published, and the refusal names the block it is in without repeating the
number. A picture declared at upload to show identifiable persons reaches a
published page only after the board confirms that everyone recognisable in it
has given publication consent. And a picture the instance no longer holds, or
one that is not served publicly, is refused rather than left to appear as a
broken picture on the street. A draft is deliberately not scanned: nothing on it
is readable by anyone, and refusing to save half-written text would only move
the writing somewhere with no guardrail at all.

Publishing a page, taking one down and changing who may read it are each written
to the audit log in the same transaction as the change itself, so the record
cannot claim a publication that was rolled back or miss one that stood. A write
that changes nothing writes nothing.

Every instance now ships a privacy notice: a page at a fixed address carrying the
headings a notice has to answer and no text under them, written when the
cooperative is claimed, backfilled on the next start for an instance claimed
earlier, and linked from the footer of every page the website publishes. The
text is the association's own, like any other page, because what a particular
cooperative does with personal data is not something a platform can write on its
behalf.

The editor warns, permanently, against writing about a named person's health,
finances, religion, politics or family situation on a page the association
publishes, and it says so before anything is typed rather than after something
is refused.
