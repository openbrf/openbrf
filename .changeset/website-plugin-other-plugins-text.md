---
"@openbrf/api": patch
---

Keep website plugins from reading what other plugins collected.

A plugin that builds blocks for the public website could call an action of
another plugin that returns text or pictures that plugin collected, and show
them on the public site. It can no longer: it keeps its own actions. It also
can no longer call a core action outside news, menus and facts that returns
pictures of people, as it already could not call one that returns text written
for the board.
