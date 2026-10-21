---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

The issue queue no longer shows the apartment of a reporter with protected
personal data. It already withheld their name, but a signed-in resident can only
report about their own apartment, so the apartment beside the withheld name said
where they live. The queue is read by the property manager as well as the board.
The row now says the apartment is not shown, for every handler. The location and
description the reporter wrote are still shown, and the reporter's own list of
reports still shows the apartment.
The protected reporter in the queue also no longer carries the person's id, so a
handler cannot use that id to link a protected row to an earlier row where the
same person was shown. The location and description stay in the row, so a
distinctive one can still point to the same reporter.
