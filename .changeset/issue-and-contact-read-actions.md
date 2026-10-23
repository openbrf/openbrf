---
"@openbrf/api": minor
"@openbrf/i18n": minor
---

A connected app can now read the issue queue and the contact form inbox, as
the person who signed it in. `issue_list` reads the queue a page at a time,
filtered on status, type or audience, and `issue_get` reads one issue: its
type, status, location, description, apartment, reporter, dates and how many
photographs it has. Both need the right to handle issues, which the board and
the property manager hold. `contact_message_list` reads the messages written
through the website's contact form, for the board. None of them changes
anything, and none gives out an email address or a photograph. An issue
reported by a person in the register who has protected personal data is never
given out: it stays on the board's own screen. A contact form message, and an
issue whose reporter is not in the register, is given out as written, because
the platform cannot tell whether its sender has protected personal data. The
actions are offered to connected apps and to
the AI package, not inside the web interface, which reads the same rows
through its own screens.
