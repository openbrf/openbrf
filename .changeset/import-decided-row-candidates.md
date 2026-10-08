---
"@openbrf/api": patch
---

Hold a choice the board made for an import row to the persons it chose
between. A row the board gave to a person it chose is now also checked against
the register inside the transaction that writes it, as a row it made a new
person already was, so somebody who joins the row's candidates while the
import waits for its locks stops it instead of being passed over. A row the
board decided to leave out no longer stops the import when its candidates
change, since it writes nothing whoever it matches.
