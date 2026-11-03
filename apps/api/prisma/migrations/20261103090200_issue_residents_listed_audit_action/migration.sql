-- The audit action of the resident picker a handler opens an issue from
-- (ADR 0054): a handler was told who lives in one apartment today.
--
-- Its own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and Prisma runs each migration in
-- one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_RESIDENTS_LISTED';
