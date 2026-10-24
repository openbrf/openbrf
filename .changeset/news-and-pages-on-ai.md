---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

The news and page actions are offered to an AI package, on the `ai` surface,
so an assistant can write the association's news and pages from a prompt
(ADR 0038, "News and pages on `ai`"). Each write it makes is held as a pending
change that only the person who asked can confirm, after reading it in full.
The deletes, the front page, the order of the pages and the menu are not
offered.

A pending change to one news item or page now shows that item or page as it
stands when the change is read: its title, its address, whether it is
published and who can read it, with what confirming changes beside each. A
renamed page that still takes its address from its title shows the address
confirming moves it to. A change whose item is gone says so.

No news action sends a mailing. An assistant can place a mailing request, and a
board member then answers it. A news item that was taken down while its mailing was
going out is no longer published again through an action, because publishing
it would send the rest of the mailing: the action refuses it with
`mailing-would-resume`, and the board publishes it again on its own screen.
A proposed `news_update` must carry `expectedRevision`. A connected app that
updates a news item directly may still leave it out.
