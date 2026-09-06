-- The sixteen audit actions the data protection records are written with.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
-- The tables these actions are written about are created by
-- 20260913100000_data_protection, which uses none of them.
--
-- Each entry names the act and the row it happened to. What the board wrote -
-- a breach description, the ground for a decision, a note on an agreement -
-- stays on the row and never enters the log's context, because the audit log is
-- append-only and free text copied into it would outlive the record it
-- described.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PERSONAL_DATA_BREACH_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PERSONAL_DATA_BREACH_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PERSONAL_DATA_BREACH_DECIDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PERSONAL_DATA_BREACH_SUBJECT_INFORMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PERSONAL_DATA_BREACH_CLOSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROCESSING_ACTIVITY_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROCESSING_ACTIVITY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROCESSING_ACTIVITY_ENDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROCESSOR_AGREEMENT_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROCESSOR_AGREEMENT_ENDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DATA_SUBJECT_REQUEST_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DATA_SUBJECT_REQUEST_DECIDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DATA_SUBJECT_REQUEST_CLOSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DATA_PORTABILITY_EXPORTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSOCIATION_DATA_PROTECTION_CONTACTS_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PRIVACY_NOTICE_HEADINGS_ADDED';
