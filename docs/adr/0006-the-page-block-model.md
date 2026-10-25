# ADR 0006: The page block model and the publication guardrails

Date: 2026-08-29, amended 2026-10-18 (one definition per block type, plugin
blocks, and rendering a plugin's block) and 2026-10-19 (layout blocks, and the
editor drawing the page with the website's stylesheet)

## Status

Accepted. Amended by [ADR 0027](0027-the-website-editor-model.md): a page's
`published` flag and visibility are one status, and the front page is a page
the board chooses rather than the menu's first entry.

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

A page's body is `{ version: 1, blocks: [...] }` in a JSON column. Each block
type is declared once, by a definition in `packages/shared/src/page-blocks`
(see "One definition per block type" below), and rendered by its entry in
`BLOCK_RENDERERS` in `apps/api/src/site/site-html.tsx`. The first three were:

- `paragraph` and `heading` (levels 2 and 3), each holding **text runs**:
  `{ text, bold?, italic?, link? }`. Marks are flags on a run rather than nested
  markup, so there is no tree to get wrong and no attribute a page can choose.
- `image`, holding the **id** of a stored file plus alternative text and an
  optional caption. An id and never a URL, so a block cannot name another host.

The forms, the news teaser, the calendar, the document list, the board roster,
the association facts, the controller contact and the FAQ followed on the same
terms: none of them carries a URL or markup, and the ones that show what the
instance holds carry no copy of it.

The renderer emits React children, which React escapes, so a paragraph
containing markup is shown as the characters the board typed. The only two
attributes that are not text are a link's address and a picture's, and neither
is free: a link is limited to `http`, `https`, `mailto` or a path on this
instance, and a picture's address is built from an id through the media route.

Adding a block type is therefore a visible change to a definition and to its
renderer, and that pairing is the safety argument. A block type nobody has added
renders as nothing.

### One definition per block type

A block type used to be added in four places: the `PageBlock` union,
`renderBlock`, the strict write schema and the total reader. The compiler caught
the first two; the last two were switches over a string, so a type missing from
one was a block the write path refused, or one that vanished on every read
while the write that stored it had succeeded. The editor kept its own copies of
three more - what a new block starts as, what of it the guardrail scans, and
when it is finished enough to send - and its scan had to agree with the API's
about which block a personal identity number was in.

Each type is now one `BlockDefinition`, and `PAGE_BLOCKS`, the registry over
`CORE_BLOCKS`, answers every one of those questions by looking the type up. A
definition holds:

- the **type id**;
- the **strict schema** the write path accepts, built from the caller's zod so
  that it is made of the copy the API validates and publishes with;
- the **total reading** of a stored block: null drops it, and nothing throws;
- what the write path **stores** of an accepted block;
- the **text** the publication guardrails scan;
- the **stored files** it shows and the **destinations** its buttons lead to,
  for a block that has either, so the guardrails check every picture and the
  renderer resolves every page a button names without a list of block types of
  their own;
- **how the editor offers it**: its label and add-button label as i18n keys, an
  icon name, a category (text, media, layout or association), the block it
  starts as, whether it is finished enough to send and what of it is sent - a
  columns block goes without the pictures nobody chose a file for - and
  whether it may sit inside a column.

It lives in `packages/shared` because both applications read it, and that is
what the editor's scan agreeing with the server's now rests on: it is the same
function. The renderer is the one part that is not on the definition. Only the
API renders the website, and its renderers use the site's own chrome, forms and
facts, so they stay beside the rest of the markup - but `BLOCK_RENDERERS` is
keyed by the registry's types, so a registered type with no renderer is a
compile error. Adding a block type is one definition, its line in
`CORE_BLOCKS`, its renderer and its labels in both locales.

The label keys keep their literal types (`defineBlock<B>()({ ... })`), so the
editor's typed translation function refuses a key that is in neither locale at
compile time.

Columns nest one level and never hold columns. Only the paragraph, the heading,
the picture and the button may sit in one for now: a block that reads something
per page - a form, a list of news - stays out until the renderer and the form
endpoints look inside columns for it, and so does every layout block. The
columns definition builds its strict schema as a discriminated union over
exactly those four definitions, so a column holding columns is refused by the
write path's shape rather than by a check, and dropped by the read path like a
type nobody knows. A plugin's block does not sit in a column either, registered
or not; whether it may is a decision for the step that registers plugin blocks.

### Layout blocks

Four blocks arrange a page rather than write it: a **banner**, **columns**, a
**button** and a **picture beside text**. They are held to the rules above and
add three of their own.

- **A picture is described.** A banner's picture and a picture beside text
  require alternative text that is not blank, on the write path and on the
  read. Each is the most prominent picture where it stands, and the one a
  reader who cannot see it most needs told about. A picture block keeps the
  rule it had: required, and empty for a picture that carries nothing the text
  does not already say.
- **A button leads somewhere this instance can name.** Its destination is one
  of two, the menu's two: one of the website's pages **by its id**, the
  built-in pages among them (the news, the calendar, the broker information
  page; ADR 0027), or an address that is **https** and publishable. Never a
  path typed by hand. The page is resolved when the page carrying the button is
  rendered, under the menu's rule: published, and public or read with a
  session. A button to any other page is **not rendered**, so a button cannot
  become the way an anonymous visitor learns that a member-only page exists,
  and a page renamed keeps its buttons. Nor is a button to the account request
  form, which the menu offers only to a visitor with no session while the
  board takes requests.
- **Words do not stand on a photograph.** A banner's heading, text and button
  sit on the theme's raised surface below the picture. The contrast of text
  laid over a photograph depends on the photograph, and the theme can only
  vouch for its own surfaces.

Every picture they show - in a banner, beside text, inside a column - is one of
the page's pictures to the guardrails: it needs a public file and a confirmed
consent, and a refusal names the block the board sees, which for a picture in
a column is the columns block. Every word on them, a button's label and a
banner's description included, is scanned, and so is a button's address.

All four render on the server in the theme's tokens with no script. Columns and
a picture beside text are side by side from a width a column stays readable at
and one under the other below it, in the order of the markup; a picture beside
text moves by grid area, so it stays first in the markup and above the text on
a telephone whichever side the board chose.

### Plugin blocks: namespaced types, and the ones nobody registered

A core block's type id is a bare lowerCamelCase word. A plugin's will be
namespaced by the plugin's id, `<plugin id>/<name>`, so two plugins cannot
claim one type and neither can claim the core's; `createBlockRegistry` refuses
an id of neither shape and a type claimed twice. How a plugin's definition is
registered and its block rendered is the next section. This one settles what a
page holds when a plugin's block has no definition - because the plugin was
removed, or is switched off for an afternoon:

- It **renders as nothing**, exactly as an unknown type always has.
- It is **kept as stored**. The read path returns it untouched (copied through
  JSON), the editor shows it as "a plugin's block" with the controls to move
  and remove it, and the write path accepts it back. A save carries the whole
  page, so dropping it there would delete the board's work because a plugin was
  switched off.
- It is **bounded** by the two things this version can measure without knowing
  its fields: its size as JSON (`PAGE_CONTENT_LIMITS.unregisteredBlock`) and
  how deep it nests (`unregisteredBlockDepth`). Over either, the write path
  refuses it as a validation result and the read path drops it. The depth is
  measured with a loop rather than a recursion, so a block nested deeper than
  the call stack is an answer and not an exception.
- Every string on it is **scanned** by the publication guardrails, as words and
  as an address both. Nobody here knows which of its fields the plugin will
  print or link to once it is back, so it is held to more than any block this
  version can read. The scan is a loop too: it runs on whatever a page holds,
  in the editor as well as on the write path, and must answer for any of it.

A bare type outside the registry is not one of these. It is a block from a newer
core, and it is still dropped on read and refused on write.

The write schema is a union of the discriminated union over the registered
types and an envelope for the unregistered ones. Zod reports a failure in both
halves of a union as one `invalid_union` at the block, which would lose the path
the editor uses to say which link it will not publish. The envelope's type check
therefore aborts: a block of a registered type fails it fatally, zod reports the
one half that failed without aborting, and the refusal keeps its path into the
block. A block wrong at its root - a field no type declares - is refused at the
block, which still names it.

The actions are the one surface that does not take such a block back. Their
published input must be strict at every depth, and an unregistered block's
fields are exactly the keys nobody can declare, so `page_create` and
`page_update` take the registered types only. Their output shows the block,
so a caller is refused with a reason it can act on rather than reading a page
that hides it and deleting it on the next save.

### A plugin's block is rendered by its plugin and printed by the host

A plugin declares its blocks in its manifest - a name, a label, an icon, a
category and the settings the board fills in - and its server bundle registers
a render function for each (docs/plugin-contract.md). Declaring one asks for
the `site:blocks` permission, which the board consents to at install.

**The registry is the core's and the serving plugins'.** The API registers a
definition for each declared block that has a render function, made from the
declaration by `pluginBlockDefinition` in `packages/shared`, and the editor
makes the same definitions from the declarations the API lists, so the two
agree about when such a block is ready to send. A block is stored as
`{ type, settings }`. The registry with the plugins in it answers two
questions: what the editor offers, and what the board's own write path accepts

- a serving plugin's block is held to its declared settings, and refused with
  the path of the setting that is wrong. A setting the declaration no longer has
  is dropped rather than refused, as the plugin's own settings form drops one,
  because otherwise a plugin's upgrade would leave the board unable to save a
  page for a reason it cannot see.

Reading does not use it. A stored body is read against the core's registry,
where a plugin's block is an unregistered one kept exactly as stored, so a page
reads the same whether its plugin is serving or not, and nothing in the read
path depends on which plugins happen to be loaded. A plugin's block is
therefore held to the unregistered block's size when it is written, too: it is
read as one the moment the plugin is switched off. Its text is scanned as an
unregistered block's is, every string as words and as an address, registered or
not, because its renderer is somebody else's code. The page actions keep to
the core's types: their published input is fixed when the instance starts.

**The renderer is the plugin's; the markup is the host's.** A plugin's render
function answers with a tree of elements, not with HTML, and the host reads the
answer as data from elsewhere: copied out through JSON first, so a getter runs
once and a cycle is an answer rather than an exception; then held to a short
list of elements - text, lists, tables, links - and three attributes, each to
its own rule. An element not on the list is dropped with everything inside it;
every other attribute is dropped. A link is held to the rule a run's link is.
What passes is printed through the same React renderer as every other block,
so text is escaped. There is no element that loads anything, so a plugin's
block cannot name another host any more than the board's can, and the content
policy that names no script source still holds for the page as a whole. A tree
rather than sanitised HTML because this is the decision above, applied to a
second writer: an HTML sanitiser would make what reaches a visitor a question
about a parser's corner cases, and a closed list of shapes makes it a question
about the list.

**One plugin's fault hides one block.** Every plugin block on a page renders at
the same time, each with a limit (`PLUGIN_BLOCK_RENDER_TIMEOUT_MS`, two
seconds). A render that throws, takes longer, or answers with something the
host will not print is left off the page, logged with the plugin's id and the
reason and never with the content, and the rest of the page renders. So is one
that renders something shaped like a personal identity number: the guardrail
that refuses the board a page carrying one would otherwise be one plugin away
from meaningless.

**A plugin that adds blocks does not read the register.** `site:blocks` is
refused beside either address-book permission. The import boundary below is
what makes "the public website cannot publish register data" a property of the
module graph; a plugin whose block could ask the address book what to print
would be a path around it. Nor does it reach the members' details through the
actions it dispatches. A plugin is offered, and may call, only the actions whose
personal data its own declaration names, and some of those return members'
details to whoever on its route may call them: `motion_queue_list` and the news
comment actions return names. So a plugin that asks for `site:blocks` declares
no personal data but `freeText` and `photograph`, the published text and
pictures the content permissions hand it, and a manifest declaring any other
category beside `site:blocks` is refused (`blocks-declare-member-data`). The
allowed categories are listed rather than the refused ones, so a category added
later is refused beside `site:blocks` until somebody has decided otherwise.
`freeText` is published text only in the news, pages, menu and facts action
groups. The core's other actions that declare it (the motion titles, the
meeting agenda, the issue labels) return text written for the board, which may
name somebody, so dispatch refuses them to a plugin that asks for `site:blocks`
whatever it declares.
Permissions are not a sandbox (ADR 0003), so this holds an honest plugin to the
boundary; curation of the catalog is what stands between an instance and a
hostile one, as it is for everything else a plugin does. That includes the
plugin's view, which runs in the application's page as the signed-in person and
reaches the core's routes as that person does, outside every check that binds
the plugin's server code.

The render function is told the block's settings, the language and a
translation function in its own namespace, and nothing about the reader. One
stored page is rendered for a visitor and for a member, and a block whose
output depended on who was reading would be the first part of a public page
that did.

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
  taking a page down, deleting a published page and moving a published page
  between the members and the street each write `PAGE_PUBLISHED` or
  `PAGE_VISIBILITY_CHANGED` through `record(entry, tx)` inside the transaction
  that made the change, and choosing the front page writes
  `PAGE_FRONT_PAGE_CHANGED`. A write that changes nothing writes nothing.

There is one renderer, so the board never sees a second opinion about the page.
The page editor draws the blocks it edits in the website's own markup under the
website's own stylesheet, which it shares with the renderer rather than copies
(ADR 0027, "The page is edited as it is drawn"), and stands the blocks only the
server can fill in as cards that name them.

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

- **A block type needs configuration richer than text and ids.** Its
  definition is the place that decision is made, and a block that carried
  arbitrary key-and-value settings would weaken the argument above.
- **A plugin's block needs a picture, an embed or a form.** None of the three
  is on the list a plugin's output is held to, deliberately: a picture needs an
  address the host builds, an embed is a third party, and a form needs an
  endpoint. Each is a new kind of element with its own rule, not an entry added
  to the list.
- **A plugin's block needs to know who is reading.** Today it is told nothing
  about the reader. Telling it would make a public page's content depend on a
  session through code the core does not review.
- **The consent check becomes per-person.** Tying a picture to the persons it
  shows, and those persons to their `PHOTO` consents, replaces the confirmation
  with a check. The declaration recorded at upload is already the input it would
  need.
- **The page body is reused by something that is not a page.** News bodies
  already use this parser; a third caller is the point at which the block model
  stops being the website's and becomes the platform's.
- **An association asks to embed a third party.** Refusing is a decision, not an
  oversight, and the request is the thing that should reopen it.
