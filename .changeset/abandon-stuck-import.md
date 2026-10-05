---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Let an administrator abandon a member list import that is stuck.

Only one import runs at a time, so an import left queued after its job was
lost, or held applying by a hung attempt, refused every other import until the
next restart or until the queue had spent its retries. An administrator can now
end it from the import screen, or with `POST /api/import/sessions/:id/abandon`.
The route needs `association:manage` on top of the address book capabilities
every import route needs, so the board cannot use it.

The screen keeps showing a running import after its upload's 24 hours are up,
since that is when a lost job is most likely to be found. The import is
recorded as stopped with `apply-abandoned`, and another import can be applied
straight away. What it had already written stays in the member
register. The job behind it writes nothing more: a chunk in flight is waited
for, and a retry or re-queue that comes for the import later finds it stopped
and does nothing. Each abandon writes an `IMPORT_ABANDONED` audit entry naming
who did it, how many rows the import had reached, when it had started and who
uploaded the file.

An import that has written every row is not abandoned: the abandon is refused
as `session-not-running`, and an import an earlier version left applying with
every row written is marked applied instead. The last chunk of an import now
marks it applied in the same commit that writes its rows.
