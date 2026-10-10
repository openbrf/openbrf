---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Send only the seller the board chose for the apartment on screen when a move-in
records a transfer.

Changing the address, the apartment or what is recorded clears the previous
holder, and the form sends a previous holder only if they hold the apartment now
chosen. Before, a seller picked for one apartment could be recorded as the seller
of the next one, in a register that cannot be corrected afterwards.

The form also says when the apartment's holders are still being read or could
not be read, and does not record a transfer until they have arrived. A failed
read of the addresses or of an address's apartments is shown with a way to try
again, and an answer for an address the board has already left no longer
replaces the apartments of the one chosen.
