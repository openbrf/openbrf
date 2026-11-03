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
- **Assigned.** A handler giving an issue to somebody mails that person, once:
  an issue handed to them, away and back within the hour, mails them one time.
  A mail that was not sent, because the issue had been handed on by the time it
  went out, does not count: giving the issue to that person again mails them.
- **Overdue.** The assignee is reminded once, the morning after the target date,
  when the issue is not done. A new target date that passes gives a new
  reminder. A date set again, or moved away from and back to, does not. An issue
  given to somebody after its date has passed gives them the reminder then. A
  reminder that could not be sent, because the issue was given to somebody else
  or the mail could not go out, does not count as sent; the date is owed again.
- **Reopened.** A done issue that is opened again is mailed to its assignee, or
  to everybody who handles it when it has no assignee. Reopened twice within the
  hour mails once, unless the first mail was not sent because the issue was
  closed again by then.
- **A new message.** A reporter's message mails the assignee, or everybody who
  handles the issue when it has none. A handler's message mails the reporter
  when they have an account. A handler's internal note mails nobody.
- Nobody is mailed about their own action. A board-only issue is never mailed to
  the property manager. A person whose processing is restricted (GDPR art. 18)
  is not mailed: the restriction is checked when the mail is queued, when it is
  delivered and again after the address is decrypted, just before it is handed
  to the mail service.
- **No free text.** A mail gives the issue number, the type, the priority and a
  link to the issue queue. It never includes what the reporter or a handler
  wrote, where in the building the issue is, or who reported it. That text does
  not pass through the mail provider.
- **Issue number.** Every issue has a number, shown in the issue queue, on the
  reporter's own list and in every mail, and returned by the `issue_list` and
  `issue_get` actions. Existing issues are numbered in the order they were
  filed.
- **A bound on the mail reports send.** Handlers get mail about at most ten
  ordinary reports from the website's form an hour, and at most ten urgent ones
  as well, so ordinary reports never hold back the mail about an urgent one.
  Each signed-in reporter has a budget of their own: five ordinary reports and
  five urgent ones an hour, which one reporter's reports cannot spend for
  anybody else. Past a budget, a report is still filed and shown in the queue,
  but nobody is mailed about it. An issue a handler opens has no budget.
- **A bound on the mail messages send.** Each reporter has handlers mailed
  about at most ten of their own messages an hour, across all of their issues.
  Past that, a message is still stored and shown in the conversation, but
  nobody is mailed about it. One reporter's messages never spend another's
  budget, and a handler's message to the reporter has no budget.

The issues row of the record of processing activities now names the mail
server among its recipients, counts board members and former residents among its
data subjects and says what the mails contain. A row the board has not edited is
updated at the next start. A row the board has edited keeps the board's words,
so a board that edited it should add these four points itself.
