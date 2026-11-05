---
"@openbrf/api": patch
"@openbrf/web": patch
---

Smaller fixes to making a charge from an issue.

- A charge made from an issue now waits for an administrator who is changing who
  handles that issue, so it can no longer link to an issue its maker has just
  stopped handling.
- The charges screen reads the issue it was opened from without also reading the
  charges made from it, and reads the issue again when you leave it and come
  back, so the form is not filled in from the first visit.
- A person's own data subject access report names the issue they reported in a charge's
  entry, even when they have protected personal data. Other readers still do not
  see it.
- An open issue panel reads the responsibility guide and the issue's charges
  again when the issue changes, not whenever the queue is filtered or searched.
- The note that a reply is not a notice to remedy shows once for an issue, not
  in the status form and again in the handling panel.
- The public report form asks for the responsibility guide at the same time as
  the issue types.
