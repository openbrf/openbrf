---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Issues can be assigned, prioritised, given a target date and kept to the board
(ADR 0054).

- **Assignee.** A handler gives an issue to one person who handles it, gives it
  to somebody else, or leaves it unassigned. Only people the issue lets in can
  be chosen, and the list of them gives names and nothing else: no address,
  telephone or apartment.
- **Priority and target date.** A handler sets an issue to urgent, normal or low,
  and can set the day it is meant to be done by. An issue past that day and not
  done is marked overdue in the queue. Nothing counts time from either. A
  reporter never sets the priority.
- **Defaults per type.** A type files its issues with a priority and, if the
  board names one, an assignee. A new instance's water leak type files as
  urgent. A type with no assignee, or one whose assignee no longer handles it,
  files its issues unassigned.
- **Who handles a type.** A type is handled by every handler or by the board
  alone. The board here means a board member with a seat, or an administrator
  whether or not they hold a seat. A single issue can be closed to all but the
  board. The property manager is not shown an
  issue or a type the board keeps to itself, in the queue or through the
  actions. They are not served its photographs, even from an address they
  opened before, and a post in the feed does not show them its status. Their
  counts of a type's issues leave such issues out. A type the board keeps to
  itself is not offered to them to report under as a handler, though they may
  still report under it on the ground anyone else would: as a resident when it
  takes reports from residents and they live here, or as a member of the public
  when it takes reports from the public and they do not. Handing a
  type to the board, or closing an issue to it, unassigns a property manager who
  was its assignee.
- **Issues a handler opens.** Any handler, the property manager included, opens
  an issue for a named resident, who is then its reporter and sees it among
  their own reports, or opens an internal issue with no reporter. The issue
  shows which handler entered it. A resident is named from a picker, not the
  address book: the handler chooses an apartment, then one of the people living
  there today. The picker has no search and lists nobody who has moved out or
  not yet moved in. A resident with protected personal data is listed as
  protected and never by name. Each list of an apartment's residents is
  recorded in the audit log, with the apartment and how many were listed but
  not who.
- **Timeline.** Each issue has a timeline of who did what and when: reported or
  opened, assigned, priority, target date, status and access. It is read from
  the audit log. A handler with protected personal data is never named on it.

A new instance's starting types include an insurance type that the board handles
alone and offers to no reporter outside the board. Upgrading leaves every existing type handled by
every handler, filed at normal priority with no default assignee, and every
existing issue unassigned at normal priority with no target date.

The data subject access report has a new section listing the issues a person is
assigned and the types that name them as default assignee. It shows the type,
the status and the dates, and never the issue's text or its reporter. The purge
clears a purged person from these assignments.
