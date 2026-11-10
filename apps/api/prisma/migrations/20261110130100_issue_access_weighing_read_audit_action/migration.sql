-- The audit action of a board member reading an issue's texts to weigh them
-- for one person's access report under GDPR art. 15(4) (ADR 0057).
--
-- Its own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it. Nothing below uses it; the
-- service does, once it has run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_ACCESS_WEIGHING_READ';
