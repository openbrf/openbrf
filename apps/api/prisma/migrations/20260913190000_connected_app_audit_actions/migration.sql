-- What connecting an external client has to be able to record.
--
-- A connection is a member handing out the ability to act under their own
-- capabilities, and cutting one is how that is taken back, so both are acts the
-- log has to carry against the person who performed them. The client itself
-- goes in the entry's context beside the channel, not in a column.
--
-- Registration is separate from consent and is recorded separately: a client
-- presenting the URL of its own metadata document becomes known to the instance
-- without any person having agreed to anything yet.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONNECTED_APP_CONNECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONNECTED_APP_DISCONNECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OAUTH_CLIENT_REGISTERED';
