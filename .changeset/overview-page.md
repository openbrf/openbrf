---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

Signing in now lands on an overview at `/app` (Översikt). Everybody who lives
in the house sees what they have sent in and are still waiting on - open
issues, and motions, subletting applications and key orders the board has not
answered - with each one's status and a link, their upcoming bookings, the next
events and the three newest news items. Whoever works a queue also gets "Att
hantera": one row per queue their account holds, with how many items are
waiting and a link to it - new issues, unanswered threads in the board mailbox,
motions not yet received, subletting applications and key orders to answer,
account requests and reported posts. A panel whose read fails says so
on its own; the rest of the page still shows.

The address book has moved to `/app/address-book`, and its entry in the
navigation is now under Styrelsen and offered on the board's view of it. A
resident still reaches the resident directory at that address, but the menu no
longer carries a link to it for them. The phone bar's first column is the
overview, for the board and for residents; residents' bar no longer holds
Nyheter, whose newest items are on the overview.
