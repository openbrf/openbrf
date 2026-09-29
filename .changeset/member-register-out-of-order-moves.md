---
"@openbrf/api": patch
---

Write the member register's ENTRY and EXIT rows by the dates of a person's
moves, not by the order the moves are entered in.

Whether a move began or ended a membership was decided by counting the
person's other tenant-ownerships that had not ended by its date, including
ones that had not begun by then either. So a back-dated move-in entered after
a later one wrote no ENTRY and dated the membership from the later one; two
move-outs entered against their date order each saw the other apartment as
still held and neither wrote the EXIT, leaving the person a member for ever;
and leaving one apartment before taking over one bought for later wrote no
EXIT for the months in between. An import had the same fault, and the
register it left depended on which of a person's apartments the file listed
first.

Moves and the import now share one rule. A tenant-ownership counts only on the
days it is held, a membership ends on the latest move-out once none is held,
and the rows a change writes are the ones that make the register read, day by
day, as the person's residencies do. An import settles each person once per
chunk of rows, so a file lists a person's apartments in whatever order it
likes. Rows already in the register are not changed.
