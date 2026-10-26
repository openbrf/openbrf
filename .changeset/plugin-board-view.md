---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
---

A plugin whose view is for the residents can now declare a second view for the
board, `boardView`, with its own module, its own title and the capability the
board's routes behind it require (ADR 0051, amended). The board's page stands
under `/board/plugin/<id>`, among the board's pages, with the board's sign on
its heading and the sentence saying who sees it, and its entry stands in the
board's section only. It is offered to a board seat that holds the declared
capability and the floor of the plugin's routes. Anybody else who opens its
address reads the sentence every refused board page says, and the plugin's
module is not loaded for them. Opening it ends the resident preview, and no
preview offers it. `GET /api/plugin-views` answers each view's `boardView`,
with whether the account is offered it.

The manifest refuses a board view with no view beside it, beside a view in the
board's section or one that names no section, in a section other than the
board's, with the view's own module, or in a plugin that reads the address book
or the finances and declares no resident routes, whose view is the board's
already. `@openbrf/plugin-sdk` exports `pluginBoardViewSchema`, the
`PluginBoardView` type and `boardViewRuleIssues`. A manifest with one view is
read and offered as before.
