---
"@openbrf/api": minor
"@openbrf/i18n": minor
---

A connected app, and the AI package, can now read the association's issue
types with `issue_type_list`: each type's name, who it is offered to and
whether it is still offered for new reports. Issue triage uses it to suggest
which type an issue belongs under. It needs the right to handle issues, which
the board and the property manager hold, names nobody and changes nothing.
