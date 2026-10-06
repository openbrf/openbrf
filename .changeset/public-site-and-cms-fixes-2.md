---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

Fix a second set of defects in the public website, the page and menu editors
and the document archive.

- `news_list` keeps paging past a news item removed since the last call. Its
  cursor has a new form: a cursor issued before this release answers
  `not-found`, so start the list again without a cursor.
- A `page_list` cursor whose sort order is out of range answers `not-found`
  rather than a server error.
- A personal identity number in a link's address is found even when a stray
  `%` stands elsewhere in the link, or when the number's hyphen is escaped
  twice. The refusal places it by its block, without an offset into the
  block's words, and offsets in a FAQ block no longer shift past a link in an
  earlier answer. A link escaped more than four times over is decoded no
  further: the block is refused as if it carried a number, and the editor
  warns about it the same way.
- A document for the members or the public whose title, binder or file name
  carries a personal identity number is refused, since a document list on the
  website prints all three. The file name is read as it will be stored, after
  the characters a stored name may not hold are removed. A board document is
  not affected.
- A new page goes before the privacy notice in the board's list after the
  pages have been reordered, unless the board moved the notice up the list.
- Removing a page records a menu entry under another entry for the same page
  once, as its parent's child, instead of twice.
- `/nyheter?sida=` with seven or more digits shows the last page, like any
  other number past the end, and the index counts the news and reads the page
  at the same time.
