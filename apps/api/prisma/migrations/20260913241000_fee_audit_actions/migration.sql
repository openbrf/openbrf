-- What recording a fee, issuing its notices and recording what a fee is
-- calculated from have to be able to say in the log.
--
-- Six values, and none of them carries a figure. The log is exempt from every
-- purge, so an amount copied into an entry would be a permanent record of what
-- one household pays inside the entry that says it was recorded - which is the
-- rule the charge purge's own entry already states. An entry names the act, the
-- apartment or the period, and which fields moved.
--
-- The export is separate from the issuing because they are different acts by
-- different rules: issuing writes the rows, and producing the document is a
-- copy of named apartments' amounts leaving the association, so its read and
-- its entry commit together through AuditLogService.withAuditedRead.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSOCIATION_FINANCES_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APARTMENT_SHARES_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FEE_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FEE_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FEE_NOTIFICATION_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FEE_NOTIFICATION_EXPORTED';
