-- The audit vocabulary of a contractor's link to a work order (ADR 0055):
-- issuing it, withdrawing it, the contractor's answers, notes and photographs
-- through it, and the board choosing the photographs it shows. An act through
-- the link is recorded on the LINK channel the reporter's link added.
--
-- Their own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and Prisma runs each migration in
-- one. Nothing below uses them; the service does, once both have run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_WORK_ORDER_LINK_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_WORK_ORDER_LINK_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_WORK_ORDER_ANSWERED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_WORK_ORDER_NOTE_ADDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_WORK_ORDER_PHOTO_ADDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_WORK_ORDER_PHOTOS_CHOSEN';
