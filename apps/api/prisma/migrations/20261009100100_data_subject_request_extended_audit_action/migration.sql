-- The entry written when a data subject request is extended (art. 12(3)).
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The entry names the request and the new due day. The reason the board gave
-- the person stays on the row and never enters the log's context.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DATA_SUBJECT_REQUEST_EXTENDED';
