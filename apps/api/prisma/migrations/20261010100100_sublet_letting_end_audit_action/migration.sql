-- The entry written when the board records the day a consented letting ended,
-- or clears that record.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The entry carries the day and nothing else.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUBLET_LETTING_END_RECORDED';
