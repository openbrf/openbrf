---
"@openbrf/api": minor
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Keep the board's seats in the board's hands, and keep their dates plausible.

A person who holds no board seat may record and correct board positions only
while no seat that has not ended belongs to somebody who can sign in, to enter
the first board in full, and never their own seat. Seats recorded from a day
still to come count, so the days between one board and the next are not a way
in. Once a board has been elected, only a board member records elections and
ends terms. A refused write answers `board-seat-required`, and the person panel says
why.

An election dated more than a year ahead is refused with
`elected-too-far-ahead`. An election that has not begun can be given an end
date before its election date, which withdraws it: the seat then covers no day
and the position can be recorded again, also while that end date is still
ahead. A new election that overlaps an earlier
term in the same position is refused with `term-overlaps`.
