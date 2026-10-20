---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

A broker can now ask the board to look at the facts on the broker information
page (`/maklarinfo`) once they are older than the board's own threshold (three
months unless the board has changed it), or when the board has recorded facts
and never confirmed them. The threshold is counted to the instant on the Stockholm
clock: facts confirmed at 10:00 on 19 October with a three-month threshold can
be asked about from just after 10:00 on 19 January. A day the target month
does not have falls on its last day. The page then shows a short form. Only an
email address is required; a name, a firm, an apartment number and a note of
up to 280 characters are optional, and no phone number is asked for. Beside the
button the form says who asks for the address, why, on what ground and for how
long it is kept, and links to the privacy notice when the association has one.

Nothing is released or sent to the broker automatically. The request is stored
in the board's queue, and everybody who holds `site:manage` (board members and
administrators) with an email address is mailed a notice once per request. The
notice names the apartment, if the broker gave one, and links to the queue. It
carries none of the broker's details. The board answers by saving or confirming
the facts under Association facts on The website, which answers every open
request at once. The queue is on the settings screen beside the contact inbox
and in "To handle" on the overview, for whoever holds `site:manage`. The board
can dismiss a request, which deletes it.

A broker who asks what the association holds about them is answered from the
same panel: a board member enters the broker's address, and every request held
under it is emailed to that address and to no other. Delivering it there is
what verifies who is asking, and the board member is told only how many
requests it held. The requests are never added to a person's data subject
access report, because an address can be shared or change hands.

The server asks the staleness question again when a request arrives, so a form
posted over facts the board has just confirmed is answered "already current"
and stores nothing. The limits: the existing per-address limit on the route
(five a minute), one open request per apartment and three per apartment in 30
days (answered as sent), five per broker address in a day, and twenty in a day
from everybody together. The client address is not stored. The apartment is
never looked up in the apartment register.

The broker's name and address are encrypted. A request is deleted 30 days after
the board answered it and 90 days after it arrived in any case, by a nightly
purge at 03:07 UTC. It is a new row in the record of processing activities, and
the audit log records a request arriving, being answered, being dismissed and
an extract being sent, without the broker's details or the apartment. No
operator step is needed.
