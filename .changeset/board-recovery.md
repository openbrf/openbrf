---
"@openbrf/api": minor
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Record a board on a register that has none through an explicit, audited board
recovery, and nowhere else.

A person who holds no board seat no longer records or corrects board positions
through the ordinary election and end-of-term routes, whatever the register
holds. Those writes answer `board-seat-required`, as they did once a board had
been elected.

A register on which no seat is held today and none is recorded ahead is vacant,
and is recorded with `POST /api/board-positions/recovery`: the seats the general
meeting elected, and a stated reason of at most 500 characters. The recovery is
refused with `board-not-vacant` (409) while any seat is held or recorded ahead,
whether or not its holder can sign in, with `recovery-dated-ahead` (409) when a
seat is dated after today, with `board-seat-required` (403) when it names the
caller's own seat, and with `invalid-body` (400) without a reason. All
the seats are recorded or none. Each seat gets its own audit entry under the new
action `BOARD_RECOVERY_RECORDED`, which carries the reason. The data subject
access report labels the action. `GET /api/board-positions/recovery` says whether
the register is vacant.

On a vacant register the person panel's election form becomes a board recovery.
It asks for the reason, says that the reason is kept in the audit log for good,
and records that one person. Once that person signs in, they record the rest of
the board.

Upgrading: the migration adds the `BOARD_RECOVERY_RECORDED` audit action. An
instance whose board was recorded by an administrator before this release keeps
it. From this release on, that board corrects its own seats.
