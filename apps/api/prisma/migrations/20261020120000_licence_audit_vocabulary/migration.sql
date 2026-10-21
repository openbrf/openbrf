-- What entering, checking and removing an instance licence says in the log
-- (ADR 0042).
--
-- LICENCE_ADDED when a file is entered, with its SHA-256, its key id and
-- whether a key verified it. LICENCE_VERIFIED when a key a plugin declares
-- verifies it, at entry or later, with the licence id, the plugin, the issuer
-- its manifest names and the entitlements with their dates. LICENCE_REMOVED
-- with the SHA-256 and, for a checked licence, its id. A licence names the
-- association and the instance and never a person, so no entry has a target
-- person and none reaches a data subject access report except as the act of
-- the board member who entered or removed it.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LICENCE_ADDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LICENCE_VERIFIED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LICENCE_REMOVED';
