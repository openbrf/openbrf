---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Whoever handles an issue is now told about it by email, and every issue has a
number.

- **A new issue.** An issue whose type has a default assignee is mailed to that
  assignee. An issue that lands unassigned is mailed to everybody who handles
  its type.
- **Urgent.** An urgent issue is mailed to everybody who handles its type,
  whoever it is assigned to. So is an issue raised to urgent later.
- **Assigned.** A handler giving an issue to somebody mails that person.
- **Overdue.** The assignee is reminded once, the morning after the target date,
  when the issue is not done. A new target date that passes gives a new
  reminder. A date set again, or moved away from and back to, does not. An issue
  given to somebody after its date has passed gives them the reminder then.
- **Reopened.** A done issue that is opened again is mailed to its assignee, or
  to everybody who handles it when it has no assignee.
- Nobody is mailed about their own action. A board-only issue is never mailed to
  the property manager. A person whose processing is restricted (GDPR art. 18)
  is not mailed at all.
- **No free text.** A mail gives the issue number, the type, the priority and a
  link to the issue queue. It never includes what the reporter or a handler
  wrote, where in the building the issue is, or who reported it. That text does
  not pass through the mail provider.
- **Issue number.** Every issue has a number, shown in the issue queue, on the
  reporter's own list and in every mail, and returned by the `issue_list` and
  `issue_get` actions. Existing issues are numbered in the order they were
  filed.
- **Reports from the website's form.** Handlers get mail about at most ten of
  these an hour. Past that, a report is still filed and shown in the queue, but
  nobody is mailed about it.

The issues row of the record of processing activities now names the mail
server among its recipients, counts board members and former residents among its
data subjects and says what the mails contain. A row the board has not edited is
updated at the next start. A row the board has edited keeps the board's words,
so a board that edited it should add these four points itself.
