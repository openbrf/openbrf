-- What revoking a client for the whole instance has to be able to record.
--
-- An administrator turning a client away cuts every member's connection to it
-- at once, so it is an act on many people's grants and the log has to carry it
-- against whoever did it. The client is the entry's target; how many
-- connections went with it is in the context.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OAUTH_CLIENT_REVOKED';
