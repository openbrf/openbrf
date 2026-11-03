-- The audit actions of issue handling (ADR 0054): a handler opening an issue,
-- assigning it, changing its priority or target date, and closing it to all but
-- the board.
--
-- Their own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and Prisma runs each migration in
-- one. Nothing below uses them; the service does, once both have run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_OPENED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_PRIORITY_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_TARGET_DATE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_ACCESS_CHANGED';
