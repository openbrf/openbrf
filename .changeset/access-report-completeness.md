---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Put everything the association keeps against a person on their data subject
access report.

The report states the sessions a person's account is signed in with - when each
began, when it was last renewed, when it ends, and the IP address and browser it
came from - the passkeys on the account, the invitations to an account they were
sent, and every news mailing, SMS mailing and notice of a general meeting
addressed to them, with whether it went out and, where it did not, why. None of
it carries a token, a password hash or anything else that opens the account.

The printed report shows the charges, fee rates and fee notices the report
already held.

A test fails for any column in the database that names a person unless the
report reads it or the reason it does not is written down, and five such
reasons are open questions named in ADR 0019.

A signed-in session is deleted the night after it ends, unless a legal hold or a
restriction stands for the person, and the purge deletes every invitation to an
account with the account, accepted or not. The record of processing activities
says so, names former residents and everybody an invitation or a general meeting
can reach on the rows these belong to, and no longer says that the board deletes
decided sign-up requests, which nothing does.
