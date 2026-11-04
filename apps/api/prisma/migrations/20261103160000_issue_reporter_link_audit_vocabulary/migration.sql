-- The audit vocabulary of the private link mailed to a reporter without an
-- account (ADR 0055): issuing it, a handler withdrawing it, and the audit
-- channel a link holder's act is recorded on.
--
-- Their own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and Prisma runs each migration in
-- one. Nothing below uses them; the service does, once both have run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_REPORTER_LINK_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_REPORTER_LINK_REVOKED';
ALTER TYPE "AuditChannel" ADD VALUE IF NOT EXISTS 'LINK';
