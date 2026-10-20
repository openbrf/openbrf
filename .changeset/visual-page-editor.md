---
"@openbrf/web": minor
"@openbrf/shared": minor
"@openbrf/i18n": minor
"@openbrf/api": patch
---

Edit the association's website pages as they look. The page editor now has an
address of its own (`/app/admin/site/pages/<id>`) and draws the page with the
website's own markup and stylesheet, in the active theme, so what the board
writes is laid out the way a visitor will read it.

- **Write where the words stand.** The title, paragraphs, headings, captions,
  a banner's heading and text, a button's label and the questions and answers
  are edited in place on the page.
- **Add with +.** A + at the end of the page, in each empty column and in the
  tools of every block opens a list of the blocks that may stand there, by
  category, with a search.
- **Settings beside the page.** A selected block shows its settings in a side
  panel - its picture and description, where a button leads, a heading's rank,
  the number of columns - next to the page's own: who can read it, Use as
  front page, and its address under Advanced.
- **Arrange by dragging or from the keyboard.** A block is dragged by its
  handle, into and out of columns. The same handle picks it up with Enter or
  Space, the arrow keys move it through every place it could be dropped, and
  each step is announced to a screen reader; Move up and Move down stay.
- **Duplicate and remove with Undo.** The last changes to the arrangement can
  be taken back without touching the words written since.
- **Leaving with changes not saved is asked about**, inside the application
  and when the browser tab is closed.

The separate preview is gone: the page is its own preview. The website's
layout stylesheet moved from the API to `@openbrf/shared` so the editor and the
website read one copy, and a button is styled by its class rather than as a
link, which changes nothing a visitor sees. Stored pages are unchanged.
