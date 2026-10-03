---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

The member list import writes each person once, and reads a file within fixed
limits.

- Only one import is written to the register at a time. Starting a second while
  one is queued or running is refused, and the screen shows the import that is
  running. An install that has more than one running when it is upgraded keeps
  the one furthest along and records the others as stopped.
- The apply runs only the preview the screen was shown. If the upload has been
  previewed again since - in another tab, or by another board member - the apply
  is refused and the screen goes back to the column mapping.
- A row for someone who already lives in the apartment in another role, or for
  other dates, is reported as a problem with the row instead of being dropped
  without a word. Someone who moved out and back in gets their second period.
- Rows for one person are written to that person when they carry different
  identifiers, when the person's residency has ended, and when they fall far
  apart in a long file.
- An uploaded file is refused while it is being read once it passes 5000 rows,
  200 columns or 1000 characters in a cell, and a workbook once it unpacks to
  more than an import reads or names a cell it cannot place. Cells that are
  only formatted, below or beside the list, do not count. A quotation mark that
  is never closed is refused instead of turning the rest of the file into one
  cell.
- The blind indexes of stored personal identity numbers are rewritten in the
  background after the upgrade, each number dated by the day its person was
  entered rather than by the day of the upgrade.
