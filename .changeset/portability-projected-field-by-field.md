---
"@openbrf/api": patch
---

Narrow the art. 20 export field by field in the five sections that passed the
access report's rows through whole. The residencies lose the purge date, the
publication consents lose the board's note, the bookings and the event sign-ups
lose the date the purge can reach them, the motions lose their status, closing
date and erasure date, and the sign-ups lose whether the board called the date
off. The export now carries the address the person signs in with
(`person.signInEmail`), which they gave and which the whole-account omission
dropped.
