---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

A broker can now ask the board to look at the facts on the broker information
page (`/maklarinfo`) once they are older than the board's own threshold (three
months unless the board has changed it). The page then shows a short form. Only
an email address is required; a name, a firm, an apartment number and a note of
up to 280 characters are optional, and no phone number is asked for. Beside the
button the form says who asks for the address, why, on what ground and for how
long it is kept, and links to the privacy notice when the association has one.

Nothing is released or sent to the broker automatically. The request is stored
in the board's queue, and the board answers it by confirming or saving the
facts, which answers every open request at once. The queue is on the settings
screen beside the contact inbox and in "To handle" on the overview, for whoever
holds `site:manage`. The board can dismiss a request, which deletes it.

The server asks the staleness question again when a request arrives, so a form
posted over facts the board has just confirmed is answered "already current"
and stores nothing. The limits: the existing per-address limit on the route
(five a minute), one open request per apartment and three per apartment in 30
days (answered as sent), five per broker address in a day, and twenty in a day
from everybody together. The client address is not stored. The apartment is
never looked up in the apartment register.

The broker's name and address are encrypted. A request is deleted 30 days after
the board answered it and 90 days after it arrived in any case, by a nightly
purge at 03:07 UTC. It is a new row in the record of processing activities, and the
audit log records a request arriving, being answered and being dismissed
(`BROKER_UPDATE_REQUEST_RECEIVED`, `BROKER_UPDATE_REQUESTS_ANSWERED`,
`BROKER_UPDATE_REQUEST_DISMISSED`) without the broker's details or the
apartment. No operator step is needed.
