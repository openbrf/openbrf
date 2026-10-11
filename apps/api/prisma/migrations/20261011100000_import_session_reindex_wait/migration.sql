-- An apply waiting for the reindex of personal identity numbers, on its session.
--
-- "reindexWaitSince" is when the apply first found the reindex unfinished, and
-- bounds the wait from then on, whichever of the apply's jobs looks next.
-- "reindexRecheckAt" is when the job queued to look again is due. A job that
-- finds the reindex unfinished queues the next one only once this has passed,
-- in the same transaction that moves it on, so a session has one such job at a
-- time. Both are cleared by the next chunk that commits.
--
-- With a time zone and to the microsecond, unlike the session's other times:
-- both are written and compared with the database's clock, in SQL, rather than
-- with an instance's, and "reindexRecheckAt" is the very moment the queue
-- records for the job it is due with. Rounded to the millisecond, it could
-- fall after that moment, and the job would find its own claim not yet due.
--
-- No backfill. A session that is not waiting has neither.

-- AlterTable
ALTER TABLE "import_session" ADD COLUMN     "reindexRecheckAt" TIMESTAMPTZ(6),
ADD COLUMN     "reindexWaitSince" TIMESTAMPTZ(6);
