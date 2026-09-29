---
"@openbrf/api": patch
---

Carry a granted erasure request to key orders, sublet applications, the chat
and the board mailbox, and close it only once they are empty.

The service-data purge closed a request as carried out while the person's closed
key orders and sublet applications, their chat group memberships, read markers
and reports, and the board mailbox threads linked to them still stood. Each of
those purges now erases them on a granted request, and the service-data purge
counts them before it closes the request. An open key order or sublet
application is still with the board, so it is kept and the request stays open
until it closes.

The chat purge also takes a former resident out of every group each night,
recorded as `CHAT_GROUP_MEMBER_REMOVED` with no actor. The board mailbox purge
keeps a thread linked to a person under a legal hold or a restriction whatever
address the register holds for them now.
