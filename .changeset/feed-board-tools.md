---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

The board writes in the feed as Styrelsen (ADR 0026). In "Skriv ett inlägg", a
board seat holder chooses "Från": themselves, "Styrelsen", or "Styrelsen via"
their own name. They also choose "Till": Alla, Styrelsen or Administratörer,
and, writing as themselves, the group that is open.

Administratörer is a new audience in the feed: the instance's administrators
and the board. It is the one audience the administrator is in, so the board can
write to the people who run the instance and hear back from them.

A post written as Styrelsen is a news item, and takes a title as well as its
text. It is written and published in one act, through the news screen's own
path and with the same audit entries. Written to Alla, it is published to the
members on the website and in the news reader. Written to Styrelsen or
Administratörer, only that audience reads it, in the feed: it is not on the
website, the news screen or the news thread. The board's options come with it:

- "Viktigt meddelande" sends the news mailing, exactly once. It goes to the
  members for a post to Alla, and to the audience alone for any other, with a
  link to the post in the feed.
- "Fäst överst" pins it on top of the feed.
- "Tillåt kommentarer" (on unless unticked) decides whether it takes comments.
- "Visa på föreningens webbplats för alla" publishes a post to Alla to the
  street.
- "Schemalägg publicering" holds it for an instant ahead.
- "Förhandsgranska" shows it as it will read, from Styrelsen.

A scheduled post waits as a draft that only the board sees, listed beside the
feed under "Schemalagda inlägg". A job publishes it, mailing included, at its
instant. It reaches every open feed with the next poll, even when the job runs a
moment late. A post to Alla can be changed or removed on the news screen before
then, as any draft can. If a board member publishes it there first, it appears
in the feed at once, and the job does nothing when its instant comes.

Under a post to Alla, Styrelsen or Administratörer, a board seat holder can
answer as "Styrelsen via" themselves; the comment still names its writer. The
news screen's thread reads such a comment as "Styrelsen via" its writer too. The
board pins and unpins its own posts with the controls marked Styrelsen on the
card.

Only a board seat that has not ended speaks for the board. The server refuses
every one of these to a resident and to the administrator, whatever a screen
sends. It also refuses:

- a post or comment written as Styrelsen into a group;
- the website for a post anywhere but Alla;
- an ordinary post carrying the board's options.

API changes:

- New endpoints: `POST /api/feed/board-posts`, and `PUT` and `DELETE
/api/feed/posts/<post>/pin`.
- `POST /api/feed/posts/<post>/comments` takes `asBoard`, and `POST
/api/feed/posts` now refuses fields it does not know.
- `GET /api/feed/audiences` answers `mayPostAsBoard` and may list an audience
  of kind `ADMIN`.
- `GET /api/feed/posts` answers `scheduled`, and a post's news item carries its
  `text`.
- A news comment, from `GET /api/news-comments/<news>` and the
  `news_comment_list` and `news_comment_hide` actions, carries `byBoard`.
