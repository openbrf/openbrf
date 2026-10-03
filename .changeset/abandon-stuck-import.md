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

The import is recorded as stopped with `apply-abandoned`, and another import can
be applied straight away. What it had already written stays in the member
register. The job behind it writes nothing more: a chunk in flight is waited
for, and a retry or re-queue that comes for the import later finds it stopped
and does nothing. Each abandon writes an `IMPORT_ABANDONED` audit entry naming
who did it and how many rows the import had reached.
