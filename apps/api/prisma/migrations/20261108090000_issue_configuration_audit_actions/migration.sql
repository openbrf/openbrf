-- The audit actions for the board's configuration of issues: adding, changing
-- and removing an issue type, configuring one of its statuses, and saving the
-- responsibility guide. Each decides who reads and handles which issues, or
-- what a reporter is told before they report.
--
-- Their own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and Prisma runs each migration in
-- one. Nothing below uses them; the services do, once this has run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_TYPE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_TYPE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_TYPE_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_STATUS_CONFIGURED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_RESPONSIBILITY_GUIDE_SAVED';
