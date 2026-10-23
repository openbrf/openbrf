-- What an import proposal leaves in the log (ADR 0043): that a plugin proposed
-- a member list, and that a board member rejected one. Superseding, expiring
-- and withdrawing leave their state on the proposal instead, and the apply of a
-- proposal is recorded as any import's.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'IMPORT_PROPOSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'IMPORT_PROPOSAL_REJECTED';
