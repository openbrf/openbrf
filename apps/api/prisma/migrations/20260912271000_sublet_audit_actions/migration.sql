-- What happened to a subletting application: a member asked for the board's
-- consent, revised what they asked for, took the request back, the board
-- consented or refused, or somebody recorded that the rent tribunal
-- (hyresnamnden) permitted the letting after a refusal.
--
-- Each is an act the association answers for under BRL 7 kap. 10-11 §§, and one
-- a member's own data subject access report has to be able to show, so each is
-- recorded in the audit log.
--
-- Consent and refusal are two actions rather than one "decided", because they
-- are the two the statute distinguishes: only a refusal opens the tribunal route
-- in 11 §, and a log that recorded both as the same act would leave the entry
-- unable to say which of them the association is answerable for.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The table these actions are written about is created by
-- 20260912270000_sublet_applications, which uses none of these values.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUBLET_APPLICATION_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUBLET_APPLICATION_REVISED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUBLET_APPLICATION_WITHDRAWN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUBLET_APPLICATION_CONSENTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUBLET_APPLICATION_REFUSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUBLET_TRIBUNAL_PERMISSION_RECORDED';
