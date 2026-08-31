-- What happened to a motion: a member put one to the meeting, the board
-- recorded that it had received it, or the member took it back. Each is an act
-- the association answers for, and one that a member's own data subject access
-- report has to be able to show, so each is recorded in the audit log.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The table these actions are written about is created by 20260904100000_motions,
-- which uses none of these values.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MOTION_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MOTION_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MOTION_WITHDRAWN';
