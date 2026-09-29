---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Fix a set of defects in the public website and the page and menu editors.

- A personal identity number in a link's address (a `mailto:` subject line,
  say) is refused on a published page, as one in the text already was. The
  page editor warns about it too.
- The site menu can no longer end up with two entries hanging from each other,
  or with a third level, when two board members arrange it at once.
- Removing a page records each menu entry it takes with it in the audit log,
  and records the unpublication even when the page was published after it was
  read.
- Two pages created or renamed to the same address at once answer the loser
  with "address taken" rather than a server error.
- A new page is placed before the privacy notice, so the notice never becomes
  the front page.
- `page_list` keeps paging past a page deleted since the last call.
- A FAQ answer of nothing but spaces is dropped when the page is saved, not
  accepted and then lost on the next read.
- The news index at `/nyheter` lists 20 items per page, with links to older and
  newer items, instead of every item on every request.
- A public form message at the form's own length limit is no longer refused
  because of how the browser sends its line breaks.
- A document list reads only the binders it shows from the database.
- Every public page sends `referrer-policy: same-origin`, varies on
  `accept-language` and may not be framed by another site. A link written as
  `HTTPS://` gets `rel="noopener noreferrer"` like any other external link.
