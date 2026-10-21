-- The entries written when a broker asks, on the broker information page, for
-- the board to look at its facts again, when a confirmation answers those
-- requests, when a board member dismisses one, and when a board member sends a
-- broker the requests held under their address.
--
-- Their own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and PostgreSQL runs each migration
-- script in one implicit transaction. The table they record is added by
-- 20261020120100_broker_update_request, which uses no audit value.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BROKER_UPDATE_REQUEST_RECEIVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BROKER_UPDATE_REQUESTS_ANSWERED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BROKER_UPDATE_REQUEST_DISMISSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BROKER_UPDATE_REQUEST_ACCESS_REPORT_SENT';
