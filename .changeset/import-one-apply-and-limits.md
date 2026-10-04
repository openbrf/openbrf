---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

The member list import writes each person once, and reads a file within fixed
limits.

- Only one import is written to the register at a time, which the database now
  enforces as well, and every part of an import is planned again under a lock
  before it is written. An install that has more than one running when it is
  upgraded keeps the one furthest along and records the others as stopped.
  Coming back to the import screen shows the import that is still running
  rather than a newer one that has finished.
- The preview is worked out in the background, and the screen shows how far it
  has got. A long file with personal identity numbers, checked against a
  register that already holds some, no longer keeps a request open for
  minutes. That includes the preview taken again with the board's decisions. A
  preview the screen stops waiting for - another file is chosen, or
  the page is left - is stopped at once, and one the screen stops asking about
  is stopped after two minutes, so neither holds up the next one.
- The apply runs only the preview the screen was shown. If the upload has been
  previewed again since - in another tab, or by another board member - the apply
  is refused and the screen goes back to the column mapping.
- A row for someone who already lives in the apartment in another role, or for
  other dates, is reported as a problem with the row instead of being dropped
  without a word. Someone who moved out and back in gets their second period.
- A row that states its own move-in date is matched by apartment and name to
  someone whose residency there has ended, instead of creating them again.
- An uploaded file is refused while it is being read once it passes 5000 rows,
  200 columns or 1000 characters in a cell, and a workbook once it unpacks to
  more than an import reads or names a cell it cannot place. Cells that are
  only formatted, below or beside the list, do not count. A quotation mark that
  is never closed is refused instead of turning the rest of the file into one
  cell.
- The blind indexes of stored personal identity numbers are rewritten in the
  background after the upgrade, each number dated by the day its person was
  entered rather than by the day of the upgrade.
