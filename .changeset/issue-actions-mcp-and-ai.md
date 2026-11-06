---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A connected app can now assign an issue and set its priority, target date and
status, and the AI package can propose the same four changes (ADR 0056).

- **Reads.** `issue_list` and `issue_get` now carry the priority, the target
  date, whether the issue is overdue, the assignee, whether a handler opened the
  issue, and whether the board keeps it to itself. An assignee whose personal
  data is protected appears as their identifier with no name. `issue_type_list`
  also says who handles each type and its default priority. A new read,
  `issue_handler_list`, gives the people one issue may be assigned to: names
  and nothing else, with a protected person's name withheld.
- **Writes.** `issue_assign`, `issue_set_priority`, `issue_set_target_date` and
  `issue_set_status` need `issues:handle`, as the board's own screen does. From
  a connected app each takes effect at once, as the person who signed the app
  in, and the audit log records that it came through a connected app. The AI
  package can only propose them, and the person confirms on the platform's own
  screen. That screen shows the issue's number, type, status, priority and
  target date beside what the change sets, a status move's waiting reason and
  outcome as well, and for an assignment who has the issue now and who
  confirming gives it to, each by name beside their identifier when this issue
  may be given to them. Each write answers with the issue's identifier
  and what it changed, never the reporter, the description or the location.
  None of them writes to the reporter or sends anything to a contractor.
  Closing an issue with `issue_set_status` does what closing it on the board's
  own screen does: it ends every link a contractor holds to the issue's work
  orders, and clears the resident's entry permission and the known fault.
  Reopening the issue brings none of these back, and the action's description
  says so. An assignment, a raise to urgent, a reopening and a passed target
  date are mailed to handlers as they are when the board makes the same change
  on its own screen.
- **What stays inside.** An issue of a ring-fenced type, and an issue reported
  by a person with protected personal data, are answered by every one of these
  actions as if they did not exist, and so is a change already proposed for
  one when it is confirmed. No action reads or writes the conversation with a
  reporter, an internal note or a work order.
- **The MCP Connector.** The connector is offered only the actions whose
  personal data its manifest declares. Its manifest declared none, so it was
  offered none of the issue actions that carry personal data: every read,
  `issue_assign` and `issue_set_status`. `issue_set_priority` and
  `issue_set_target_date` carry none and are offered to it already. Each of
  the others is offered once the manifest declares the categories that action
  carries and the board consents: `issue_list` and `issue_get` need `name`,
  `apartment`, `freeText` and `health`, `issue_handler_list` and
  `issue_assign` need `name`, and `issue_type_list` and `issue_set_status`
  need `freeText`.
