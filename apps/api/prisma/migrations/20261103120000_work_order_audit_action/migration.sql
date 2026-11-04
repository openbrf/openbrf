-- The audit action for a handler sending a work order to a contractor.
--
-- Its own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and Prisma runs each migration in
-- one. Nothing below uses it; the service does, once both have run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_WORK_ORDER_SENT';
