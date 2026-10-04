---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Keep a news item's comments out of its removal.

A comment is its author's personal data, and the news comment purge is now the
only thing that erases one. That purge honours legal holds, restrictions and
erasure requests, and writes an audit entry for each person. Removing a news
item that residents have commented on is refused with the reason
`has-comments`, both on the board's screen and through the `news_delete`
action. The board can take the item down instead, and remove it once the
comments have been purged. A migration changes the comment's foreign key to
the news item from `CASCADE` to `RESTRICT`, so the database refuses such a
delete as well.
