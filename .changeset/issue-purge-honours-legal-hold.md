---
"@openbrf/api": patch
---

Keep the reporter of a public-form issue report when a legal hold or a
restriction of processing (GDPR art. 18) stands against the person whose
address is on it.

The public-form issue purge detached the reporter's name and address from
every report closed more than a year ago without asking whether that address
matches the registered address of a person under a legal hold or a restriction.
Like the charge, fee, key order, sublet application and board mailbox purges,
it now leaves those reports alone: it matches each withheld person's registered
address against the report, as the board mailbox purge does, and reads the hold
and the restriction again under the legal hold registry lock before it detaches
anything, so a hold placed or a restriction granted while the purge is running
is honoured.
Releasing the hold or lifting the restriction lets the next run detach them.
