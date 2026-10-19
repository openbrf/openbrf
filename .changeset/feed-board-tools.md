---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

The board writes in the feed as Styrelsen (ADR 0026). In "Skriv ett inlägg", a
board seat holder chooses "Från": themselves, "Styrelsen", or "Styrelsen via"
their own name. Written as themselves they choose "Till": Alla or Styrelsen.

A post written as Styrelsen is a news item. It goes to Alla, takes a title as
well as its text, and is published to the members on the website and in the
news reader in the same act, through the news screen's own path and with the
same audit entries. The board's options come with it: "Viktigt meddelande" sends
the news mailing to the members, exactly once; "Fäst överst" pins it on top of
the feed; "Tillåt kommentarer" (on unless unticked) decides whether it takes
comments; "Visa på föreningens webbplats för alla" publishes it to the street;
and "Schemalägg publicering" holds it for an instant ahead. "Förhandsgranska"
shows it as it will read, from Styrelsen.

A scheduled post waits as a draft that only the board sees, listed beside the
feed under "Schemalagda inlägg", and a job publishes it - mailing and all - at
its instant. It reaches every open feed with the next poll, even when the job
runs a moment late. Changing or removing one before then is done on the news
screen, as for any draft.

Under a post to Alla, a board seat holder can answer as "Styrelsen via"
themselves; the comment still names its writer. The board pins and unpins its
own posts from the ⋯ beside them.

Only a board seat that has not ended speaks for the board: a resident and the
administrator are refused every one of these by the server, whatever a screen
sends. Writing as Styrelsen to Styrelsen or into a group is refused, and so is
an ordinary post carrying the board's options. New endpoints: `POST
/api/feed/board-posts`, `PUT` and `DELETE /api/feed/posts/<post>/pin`; `POST
/api/feed/posts/<post>/comments` takes `asBoard`, and `POST /api/feed/posts`
now refuses fields it does not know. `GET /api/feed/audiences` answers
`mayPostAsBoard`, `GET /api/feed/posts` answers `scheduled`, and a post's news
item carries its `text`.
