---
"@openbrf/api": patch
"@openbrf/i18n": patch
---

Hold a choice the board made for an import row to the persons it chose
between. A row the board gave to a person it chose is now also checked against
the register inside the transaction that writes it, as a row it made a new
person already was, so somebody who joins the row's candidates while the
import waits for its locks stops it instead of being passed over. The check
also stops the import when one of the candidates leaves - moves out or is
erased - after the chunk was planned, and the chunk holds the candidates'
transition locks while it checks, so a move-out cannot slip in between. A row
the board decided to leave out no longer stops the import when its candidates
change, since it writes nothing whoever it matches. The message for an import
stopped this way now says so, rather than only that a person would have been
entered twice.
