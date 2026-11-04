-- The audit actions of the Swedish-fit fields on an issue (decisions 29 to 31):
-- the resident's entry permission given and withdrawn, the common-area place an
-- issue is about, and the mark of an inspection finding.
--
-- Their own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and Prisma runs each migration in
-- one. Nothing below uses them; the service does, once both have run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_ENTRY_PERMISSION_SET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_ENTRY_PERMISSION_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_PLACE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_FINDING_MARKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_FINDING_REMOVED';
