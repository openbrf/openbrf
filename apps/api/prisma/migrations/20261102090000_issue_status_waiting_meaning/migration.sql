-- The fourth status meaning, WAITING (ADR 0054), added to the enum the next
-- migration renames to "IssueStatusMeaning".
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one:
-- the next migration writes a WAITING status on every issue type.
--
-- BEFORE 'DONE' so the declaration order reads as the queue is worked. Nothing
-- reads that order: the queue's order is the list in `@openbrf/shared`.
ALTER TYPE "IssueStatus" ADD VALUE IF NOT EXISTS 'WAITING' BEFORE 'DONE';
