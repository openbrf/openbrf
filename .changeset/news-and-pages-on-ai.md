---
"@openbrf/api": minor
---

The news and page actions are offered to an AI package, on the `ai` surface,
so an assistant can write the association's news and pages from a prompt
(ADR 0038, "News and pages on `ai`"). Each write it makes is held as a pending
change that only the person who asked can confirm, after reading it in full.
Nothing is offered that mails the members: an assistant can request a mailing,
and a board member then answers the request. The deletes, the front page, the
order of the pages and the menu are not offered.
