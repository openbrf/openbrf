-- The audit action for an issue's known fault (känt fel, decision 22): a
-- handler published, rewrote or withdrew the notice.
--
-- Its own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and PostgreSQL runs a migration
-- script sent as one statement batch in a single implicit transaction.
-- Nothing below uses it; the service does, once both have run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_KNOWN_FAULT_CHANGED';
