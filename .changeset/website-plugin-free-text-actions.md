---
"@openbrf/api": patch
---

Keep a website plugin from calling core actions that return text written for the board.

A few actions declare only `freeText`: `motion_meeting_list`, `meeting_get`,
`meeting_set_agenda` and `issue_type_list`. They return text a member or the
board wrote, such as the titles of motions, which may name somebody. A plugin
that asks for `site:blocks` could declare `freeText`, call one of them while a
board member used its route, an MCP token or an AI package, and print the text
in a public block.

A plugin that asks for `site:blocks` is now offered, and may call, a core action
that declares `freeText` only if the action is in the `news`, `pages`, `menu` or
`facts` group. Any other such action is refused as `forbidden-surface`, and it
is left out of the plugin's action list. A plugin's own actions and a plugin
without `site:blocks` are unchanged.
