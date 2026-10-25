---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
---

Refuse a website plugin that declares personal data about the members.

A plugin may call the actions whose personal data its manifest declares, and
some actions, such as `motion_queue_list` and the news comment actions, return
members' names to a board member using the plugin's route. A plugin that asks
for `site:blocks` and declared `name` could therefore receive names and print
them in a public block, without any permission that reads the register.

- A manifest or catalog entry that asks for `site:blocks` may now declare only
  `freeText` and `photograph`. Any other category fails validation with the new
  rule `blocks-declare-member-data`. An installed website plugin whose manifest
  declares another category stops loading until a version without it is
  installed.
- Plugins joined by extensions now treat a plugin that declares any category
  other than those two as reaching the members' details, the same as one that
  reads the register or proposes imports. Such an addon is refused with
  `extension-group-refused` when it would share a group with a website plugin.
- A plugin's action calls are now limited to the categories its loaded manifest
  declares, within what the board consented to. Before, they were limited only
  by the consent, which could still include a category a later version dropped.

The plugin contract now also states that a plugin's view runs as the signed-in
person and calls the core's routes as that person. None of these checks applies
to those calls.
