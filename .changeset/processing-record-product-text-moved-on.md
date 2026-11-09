---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

The record of processing activities now shows when the product's own wording
for a row the board has edited has changed since. The seed still never
overwrites a row the board has edited, so a correction to the product's text
does not reach that row by itself. Such a row now shows, field by field, the
board's text beside the product's, with an action that adopts the product's
text for one field. Adopting writes the product's current text, is recorded in
the audit log with who adopted it and which fields, and leaves the row the
board's: the seed goes on leaving it alone, and a later change to the product's
wording is shown again. Rows a plugin seeded are not compared, because their
wording comes from the plugin's processing declaration.
