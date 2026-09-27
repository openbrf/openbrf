---
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/api": minor
---

The consent step asks whether the plugin sends personal data outside the
instance, and a screen install records the answer as the plugin's recipient.

The API took the answer on install and wrote it into the association's record
of who receives personal data (GDPR art. 28), but the screen never asked, so a
plugin installed from it read as not classified until the board classified it on
the data protection screen. The question now sits under the acknowledgement,
with neither answer chosen, and nothing installs until it is answered. "No"
records the plugin as a recipient that is no processor. "Yes" asks who the
recipient is and whether it is a processor, whose agreement is then recorded as
being made, or an independent controller, for which the reason no agreement is
needed is asked as well. An answer carrying a personal identity number holds the
install shut, because the record refuses one.

The catalog entry says which personal data a plugin handles and not where it
sends it, so the question is asked of every plugin, including one that declares
no personal data at all, and the screen offers no answer of its own.

Reinstalling or updating a plugin the record already classifies does not ask
again, and neither does installing one that was removed: the step states what
the record says and the install leaves it as it is, so an agreement the board
completed on the data protection screen is not turned back into one being made.
The catalog listing says, per plugin, what the record holds. A refusal of the
answer names the part to correct rather than saying the install failed.
