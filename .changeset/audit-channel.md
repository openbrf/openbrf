---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

The audit log now records which way each change reached the association's
records, and the data subject access report prints it.

Until now the log answered who did what, and could not say how they reached the
records. That was enough while a person in a browser was the only way in. The
column names one of five routes on every entry written from now on: the web
interface, a connected app acting as the person who connected it, the AI
package, the association's own nightly jobs, or a plugin. Where a connected app
acted, the entry also names which app.

Entries written before the column existed carry no channel, and cannot be given
one: the log is append-only, which is what makes it evidence. The access report
says so in words rather than leaving the cell blank, because a blank cell on a
statutory document reads as though nothing happened.

The report also names sixteen acts it could not name before. Twelve of them the
log had been recording all along and the document printed as an empty cell -
charges entered and corrected, the debiting list exported, the board's mailbox
worked, a transfer reversed, how the association holds its land. Those cells now
carry a sentence in the association's own words, and an act added to the log in
future cannot reach the report unnamed.

Every edit of the website's menu is now recorded, the board's own edits
included. The menu decides what is offered rather than what may be read, which
is why it went unrecorded; it is also the one place on a public page where an
address leaving the instance can be planted, so the entry names where an
external entry points.
