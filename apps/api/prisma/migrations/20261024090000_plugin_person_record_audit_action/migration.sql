-- What the plugin records purge leaves in the log (ADR 0047): one entry per run
-- that erased records about a person, with counts per plugin and collection.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_RECORDS_PURGED';
