-- What support access has to be able to say in the log (ADR 0028).
--
-- One channel and six actions. An administrator opens support access for a
-- stated time; whoever hosts the instance asks the management API for a
-- single-use sign-in link while it is open; a supporter uses the link and looks
-- at the instance read-only. Every request the supporter makes is an entry, so
-- the association's own log shows what its processor's staff looked at, when,
-- and on whose instruction.
--
-- A channel of its own rather than WEB. The entry's actor is the administrator
-- who opened the access, and on WEB that would read as the administrator having
-- done it themselves in the web interface. It is also what keeps a supporter's
-- looking out of the board's activity in the management summary, which counts
-- only the channels it names.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "AuditChannel" ADD VALUE IF NOT EXISTS 'SUPPORT';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUPPORT_ACCESS_OPENED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUPPORT_ACCESS_CLOSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUPPORT_SESSION_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUPPORT_SESSION_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUPPORT_REQUEST';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUPPORT_SESSION_ENDED';
