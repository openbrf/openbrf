---
"@openbrf/api": patch
---

Start a granted erasure only where it will be carried out.

A granted erasure request lifts the retention window and nothing else, and the
service-data purge refuses it for somebody who sits on the board, holds a system
role or still lives here. The bookings, chat, event sign-up, motion and news
comment purges ran first and checked only for a legal hold and a restriction, so
they could erase a sitting board member's rows before the service-data purge
logged the request as blocked. All of them now ask the same five questions
(hold, restriction, board seat, system role, residency), and a person refused
stays on each purge's own retention window.

Each of those purges, the board mailbox's and the service-data purge now also
take the keys a move-in, a board election and a role grant take before they ask,
so one of those committing while a purge runs is either seen by it or waits for
it, instead of the purge erasing somebody who has just become a resident, a
board member or an administrator again.
