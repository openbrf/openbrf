---
"@openbrf/api": minor
---

Hold a plugin's action dispatch to the personal data its manifest declares.

`host.actions.list` now leaves out, and `host.actions.invoke` and
`host.actions.propose` refuse with `forbidden-surface`, any action whose
`personalData` names a category missing from the plugin's own `personalData`
as the board consented to it. The refusal's `details()` name the missing
categories under `personalData`. This applies to core actions, to other
plugins' actions and to the plugin's own, whether the request on the plugin's
route came with a session or a connected app's token. Before, a plugin with no
permission to read the register, a website plugin among them, could be handed
members' names by an action such as `motion_queue_list` or `news_comment_list`
while a board member used one of its routes, and nothing a plugin declared
said so. A plugin that dispatches such actions must now declare their
categories, which also puts them on its consent screen and in the record of
processing activities.
