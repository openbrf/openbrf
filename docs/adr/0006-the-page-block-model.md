# ADR 0006: The page block model and the publication guardrails

Date: 2026-08-29

## Status

Accepted

## Context

An Open BRF instance serves the housing cooperative's own website at the root of
its own domain. That website is the only part of the product a person with no
account ever sees: a prospective buyer, a broker, a neighbour, a supplier. It is
also the only place where content written inside an instance that holds a
statutory personal-data register is served to the street.

Two questions follow from that, and they are not the same question.

The first is what a stored page may become in a browser. A website whose pages
are stored as markup lets whatever wrote the markup decide what the reader's
browser runs. For an association's notice board maintained by volunteers, that
is the wrong default in both directions: it is a route for a script to reach a
reader, and it is a route for a third party to learn that the reader was here -
an embedded video, a font from a font host, a tracking pixel pasted along with
some text from an email.

The second is what a board can put on that page by accident. A board member
writing about a leak, a parking queue or an annual meeting has the register open
in the next tab. Copying a paragraph out of it is one keystroke, and the
consequence is a personal identity number on the public internet that the
association cannot take back.

## Decision

### A page is a block list, never markup

A page's body is `{ version: 1, blocks: [...] }` in a JSON column. The block
types are declared in `apps/api/src/site/page-content.ts` and rendered by
`renderBlock` in `site-html.tsx`. Today they are:

- `paragraph` and `heading` (levels 2 and 3), each holding **text runs**:
  `{ text, bold?, italic?, link? }`. Marks are flags on a run rather than nested
  markup, so there is no tree to get wrong and no attribute a page can choose.
- `image`, holding the **id** of a stored file plus alternative text and an
  optional caption. An id and never a URL, so a block cannot name another host.

The renderer emits React children, which React escapes, so a paragraph
containing markup is shown as the characters the board typed. The only two
attributes that are not text are a link's address and a picture's, and neither
is free: a link is limited to `http`, `https`, `mailto` or a path on this
instance, and a picture's address is built from an id through the media route.

Adding a block type is therefore a visible change in two files, and that pairing
is the safety argument. A block type nobody has added renders as nothing.

### The parser is total on read and strict on write

There are two readers of the same shape, deliberately not one function.

`readPageContent` is **total**. It returns the blocks it recognises and drops
everything else, and it never throws. A body written by a newer editor, or
edited by hand in the database, therefore renders as _less_ rather than as
something the running renderer cannot vouch for. A run whose link is not
publishable keeps its words and loses the link.

`submittedContentSchema` is **strict**. The write path refuses a block type it
does not know and a link scheme it will not publish, and says so, because the
board typed it and can act on the answer.

Because the read path is forgiving, the version stays at 1 while blocks are
added. Paragraphs written before runs existed - `{ type: "paragraph", text }` -
are still read, as one unmarked run, and no migration is needed. The version
would only be bumped by a change that made an older body mean something
different.

### The editor is a mapping, not a format

The board writes text in a rich-text editor whose registered extensions are its
whole schema: a document, paragraphs, text, bold, italic and links. A heading, a
table, a colour or an image pasted from a word processor is stripped as the
paste is parsed. The editor's own document is **never stored**: it is read out
paragraph by paragraph into runs on every change, by a pure function with its
own tests.

That is what keeps the editor replaceable. What the association owns is the
block list; the editing engine is an implementation of one screen.

### The renderer's import boundary is the enforcement

Nothing under `apps/api/src/site/` may import from `registers/`,
`address-book/` or `crypto/`. That is not a style rule - it is what makes "the
public website cannot publish register data" a property of the module graph
rather than a promise about intent, and a suite asserts it on the source.

### The refusal is one document, byte for byte

A page that does not exist, a page that is not published and a member-only page
asked for without a session are one `null` from `PagesService.bySlug` and one
rendered not-found document. An anonymous visitor cannot learn that the
association has a page at an address at all. No response from the website sets a
cookie, and the content policy in `SITE_HTML_HEADERS` names no script source, so
"this website runs no JavaScript" is enforced by the browser rather than only
true of what was written.

### The publication guardrails live in the write service

One service, `PagesWriteService`, owns every write that can make a page readable
by somebody, so the rules are one rule set rather than a checklist each route
remembers:

- **A personal identity number refuses the write.** Whenever a write leaves a
  page published, every piece of text on it - the title, every run, an image's
  alternative text and caption - is scanned with the shared validator, which
  runs the anchored parse over unanchored candidates so an organisation number
  or an invoice number does not stop a board publishing. The refusal names the
  block and the offset and never the value: the value found is exactly what must
  not be repeated in a response body or a log.
- **A picture of identifiable people needs a confirmed consent.** The
  declaration made when the file was uploaded is the input; a confirmation on
  the write is the board saying the publication consents exist and are recorded.
- **A draft is not scanned.** Nothing on it is readable by anyone, and refusing
  to save half-written text only teaches a board to write it somewhere else.
- **Every publication change is audited in its own transaction.** Publishing,
  taking a page down, deleting a published page and changing a page's visibility
  each write `PAGE_PUBLISHED` or `PAGE_VISIBILITY_CHANGED` through
  `record(entry, tx)` inside the transaction that made the change. A write that
  changes nothing writes nothing.

Preview is server-rendered by the same renderer that answers a visitor and shown
in a sandboxed frame. There is one renderer, so the board sees the page rather
than a second opinion about it.

## Consequences

- **Rich formatting the board might expect is absent**, and deliberately: no
  colours, no font sizes, no embedded video, no tables. The theme decides how a
  page looks, which is also what lets a theme restyle the whole website.
- **A page cannot embed anything from a third party.** An association that wants
  a map or a video links to it instead. That is the cost of the promise that
  reading a page discloses a visitor's address to nobody.
- **The consent check is coarse this train.** It is the upload's declaration plus
  a confirmation, not a link from each face to a consent row, so it does not
  catch a board that confirms without asking. It catches the ordinary case - a
  photograph of a summer party dropped onto the front page by somebody who had
  not thought about it - which is the case the guardrail exists for.
- **Pictures for the website are stored publicly.** A picture placed on a page
  is published material, and the page it sits on decides who reads the page; the
  file behind it is fetchable by whoever holds its address. That is why the
  consent confirmation is asked for on any published page rather than only on a
  public one.
- **A newer instance's pages degrade rather than break on an older one.** The
  total parser is what makes an additive block type safe to ship.

## Revisit triggers

- **A block type needs configuration richer than text and ids.** The union is
  the place that decision is made, and a block that carried arbitrary
  key-and-value settings would weaken the argument above.
- **The consent check becomes per-person.** Tying a picture to the persons it
  shows, and those persons to their `PHOTO` consents, replaces the confirmation
  with a check. The declaration recorded at upload is already the input it would
  need.
- **The page body is reused by something that is not a page.** News bodies
  already use this parser; a third caller is the point at which the block model
  stops being the website's and becomes the platform's.
- **An association asks to embed a third party.** Refusing is a decision, not an
  oversight, and the request is the thing that should reopen it.
