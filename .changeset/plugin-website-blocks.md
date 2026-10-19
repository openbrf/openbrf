---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Let plugins add blocks to the association's website. A plugin declares its
blocks in the manifest's new `blocks` field - a name, a label, an icon, a
category and the settings the board fills in - and registers a render function
for each with `host.blocks.register`. Declaring a block asks for the new
`site:blocks` permission, which the install consent screen shows; a plugin may
not ask for it beside `addressBook:read` or `addressBook:readContact`.

The page editor offers a serving plugin's blocks beside the core's and draws
their settings form from the declaration, and a save is held to it. A block
the page already holds is never left out of a save: if a new version of its
plugin asks for a setting the block does not hold, the editor names the block
and saves nothing until the board answers it or removes the block. The
website renders each block on the server through its plugin and prints only a
short list of elements and attributes from the answer: no script, style, event
handler, picture or frame reaches the page, and a link is held to the same
schemes as a link in a paragraph. A block whose render throws, takes longer
than two seconds, or renders something shaped like a personal identity number,
in its text or in any attribute it keeps, is left off the page and logged, and
the rest of the page renders. A block of a plugin that is switched off or
removed stays on the page as stored and shows nothing. A new plugin finding, `block-refused`, reports a plugin that
registers a block its manifest does not declare.
