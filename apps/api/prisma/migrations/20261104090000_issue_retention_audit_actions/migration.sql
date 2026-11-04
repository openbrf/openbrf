-- The audit actions of an issue's two-layer retention (ADR 0057, decision 33):
-- a handler's redaction of a text or removal of a file, a legal hold placed on
-- an issue and released, and the board's setting of how long an issue's free
-- text is kept.
--
-- Their own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and Prisma runs each migration in
-- one. Nothing below uses them; the service does, once both have run.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_REDACTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_LEGAL_HOLD_PLACED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_LEGAL_HOLD_RELEASED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_RETENTION_RECORDED';
