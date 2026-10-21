-- What became of a pending change: proposed, confirmed, rejected, or left to
-- expire (ADR 0039).
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and PostgreSQL runs a migration script
-- sent as one batch in a single implicit transaction.
-- The table these actions are written about is created by
-- 20261020120000_pending_change, which uses none of these values.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PENDING_CHANGE_PROPOSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PENDING_CHANGE_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PENDING_CHANGE_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PENDING_CHANGE_EXPIRED';
