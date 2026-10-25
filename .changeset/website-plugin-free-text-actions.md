---
"@openbrf/api": patch
---

Keep website plugins from reading text intended for the board.

A plugin that builds blocks for the public website can no longer read text that
members or the board wrote for internal use, such as motion titles, meeting
agendas and issue labels. This text may name a person, and a plugin could
previously show it on the public site. Content the association publishes on its
website stays available to these plugins under the existing rules. Other
plugins are unchanged.
