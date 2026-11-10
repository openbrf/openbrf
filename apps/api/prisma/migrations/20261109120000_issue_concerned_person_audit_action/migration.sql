-- The audit action of a handler recording a person an issue concerns (ADR
-- 0057). Removing one is a redaction, which ISSUE_REDACTED already records.
--
-- Its own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it. Prisma does not wrap a migration in
-- a transaction: it runs each statement on its own, so the table migration
-- after this one opens its own. The value is kept out of that transaction and
-- committed first. Nothing below uses it; the service does, once both have
-- run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_CONCERNED_PERSON_ADDED';
