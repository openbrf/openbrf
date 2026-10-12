-- An administrator removing a theme left no entry in the log.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it: a migration file is sent as one script,
-- which the server runs as a single implicit transaction, so the value must be
-- committed by this file before any later one uses it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'THEME_REMOVED';
