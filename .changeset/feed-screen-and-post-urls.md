---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

The feed gets its own screen, at /app/feed, in place of the chat (ADR 0026).
/app/chat now goes to the feed, and "Chatt" in the navigation is "Flöde".

Posts are newest first with the pinned ones on top. Each one shows who wrote
it - "Styrelsen", or "Styrelsen via" its writer - when, and to which audience,
with the text as it was written, its line breaks kept and its web addresses
made into links, and the images on it. Under it are "Gilla" with a count, the
comments, which open under the post, flat and oldest first with likes of their
own, and "Läst av N": how many have had the post on their screen, as a count and
never as names. The ⋯ beside a post copies its text, and in a group reports it
to the board. Nothing deletes a post: the board strikes through.

"Skriv ett inlägg..." opens the composer. A resident writes as themselves, to
Alla from the whole feed or to the group or Styrelsen that is open. The text is
required, and up to four images can be attached; they are uploaded as they are
picked and the post is written once with them. "Förhandsgranska" shows the post
before it is created.

The search field and "Filtrera inlägg" - the board's posts, the neighbours',
important ones only - narrow the feed inside the reader's own audiences and
never outside them. The panel beside the feed lists Alla, Styrelsen and each
group with what is unread in it, and keeps making a group, putting a neighbour
in and leaving one.

Every post has an address of its own, /app/feed/<post>, which opens the post
with its comments: what a news mailing, a report or an issue report can link
to. A post in a group the reader is not in is refused there exactly as one that
does not exist.

Images on a post are stored like every other upload - identified from their
own bytes and encrypted at rest - and served only to whoever may read the post,
and not to the group when the board has struck the post through. They are
erased with the post, an image uploaded for a post that was never written is
removed after two days, and the access report counts the images on each of the
person's own posts. New endpoint: `POST /api/feed/images`; `POST
/api/feed/posts` takes `imageIds`.
