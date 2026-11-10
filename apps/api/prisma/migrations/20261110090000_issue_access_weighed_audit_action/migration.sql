-- The audit action of the board weighing under GDPR art. 15(4) what of an
-- issue's text goes into one person's access report (ADR 0057).
--
-- Its own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, as the concerned person's action
-- was added. Nothing below uses it; the service does, once both have run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_ACCESS_WEIGHED';
