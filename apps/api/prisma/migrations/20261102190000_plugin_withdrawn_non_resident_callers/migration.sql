-- In one transaction, so a failure leaves none of the three changes behind.
BEGIN;

-- The approved classes of caller the administrator has switched off since, on
-- the plugin's page (ADR 0053): the withdrawn set. Empty on every plugin
-- installed before it existed, which withdrew none, so the host goes on
-- serving the approved classes it served.
ALTER TABLE "installed_plugin" ADD COLUMN "withdrawnNonResidentCallers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- The withdrawal and the consent again. Neither is used in this migration,
-- which PostgreSQL would refuse.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_NON_RESIDENT_CALLER_WITHDRAWN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_NON_RESIDENT_CALLER_CONSENTED';

COMMIT;
