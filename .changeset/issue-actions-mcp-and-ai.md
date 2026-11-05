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
  target date beside what the change sets, and the assignee's name beside
  their identifier. Each write answers with the issue's identifier and what it
  changed, never the reporter, the description or the location. None of them
  writes to the reporter or reaches a contractor. An assignment, a raise to
  urgent, a reopening and a passed target date are mailed to handlers as they
  are when the board makes the same change on its own screen.
- **What stays inside.** An issue of a ring-fenced type, and an issue reported
  by a person with protected personal data, are answered by every one of these
  actions as if they did not exist, and so is a change already proposed for
  one when it is confirmed. No action reads or writes the conversation with a
  reporter, an internal note or a work order.
- **The MCP Connector.** The connector is offered only the actions whose
  personal data its manifest declares. Its manifest declared none, so it was
  offered none of the issue actions that carry personal data. It is offered
  them once its manifest declares `name`, `apartment`, `freeText` and `health`
  and the board consents.
