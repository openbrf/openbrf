-- The audit actions of a damage case (decision 28 of the issue module's plan):
-- a handler marking an issue as an insurance damage, or changing the mark, and
-- taking the mark off.
--
-- Their own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and Prisma runs each migration in
-- one. Nothing below uses them; the service does, once both have run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_DAMAGE_CASE_MARKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_DAMAGE_CASE_REMOVED';
