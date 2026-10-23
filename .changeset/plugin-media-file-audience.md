---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
---

A picture a plugin opens with `host.media.open()` now says who it is for. The
new `audience` is `anyone` for a picture held for anyone and `members` for one
held for the members, the same words a news item and an occurrence use, so a
plugin can keep a members' picture off a public page. The host still opens
both, since it cannot know where the plugin shows the picture.
